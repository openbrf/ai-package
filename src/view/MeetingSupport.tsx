import {
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  MAX_INSTRUCTIONS_LENGTH,
  MAX_NOTES_LENGTH,
} from "../meeting-limits.ts";
// Types only: a value from the server's modules would take them into the
// browser's bundle.
import type {
  AgendaDraft,
  MeetingChoices,
  MinutesDraft,
} from "../meeting-support.ts";
import { NAMESPACE, styles } from "./styles.ts";

/**
 * Meeting support: an agenda draft and a minutes draft for a general meeting.
 *
 * The board member picks the meeting from the ones the platform lists. An
 * agenda draft is proposed as a pending change, and the view links to it on
 * the platform's own pending changes screen, where the board member reads it
 * and confirms or rejects it: the view has no button that could confirm it.
 * A minutes draft is text to copy, and the view keeps it only while it is
 * open, as the package keeps it nowhere.
 *
 * One draft of each kind at a time, and an answer is shown only if it
 * belongs to the latest request of its kind, so an answer that arrives late
 * never replaces a newer one. A refusal is shown only for what is still on
 * the screen: once the meeting or the text has changed, a refusal of the
 * earlier request is dropped, as it says nothing of the new one. A draft is
 * kept, with the meeting it was written for, and so is an agenda request that
 * got no answer, as a pending change may exist all the same.
 */

const ROUTE = "/api/plugin/ai-package/meetings";

/** The platform's pending changes screen, where an agenda is confirmed. */
const PENDING_CHANGES_PATH = "/app/pending-changes";

/**
 * The reasons a meeting support route answers with that the view has a
 * sentence for: the package's own, the gateway's and the platform's for a
 * meeting it does not have.
 */
const REASONS = [
  "host-unsupported",
  "connected-app",
  "entitlement-required",
  "provider-not-configured",
  "usage-limit-reached",
  "rate-limited",
  "provider-failed",
  "notice-already-issued",
  "meeting-already-held",
  "no-draft",
  "personal-identity-number",
  "invalid-body",
  "meeting-not-found",
] as const;

type Reason = (typeof REASONS)[number];

/** Why a request has nothing to show. */
type Failure =
  /** No answer could be read, so whether the request ran is not known. */
  | { readonly kind: "unanswered" }
  | { readonly kind: "forbidden" }
  | {
      readonly kind: "refused";
      readonly reason: Reason;
      readonly retryAfterSeconds: number | null;
    }
  /** A refusal the view has no sentence for, or a fault. */
  | { readonly kind: "failed" };

type Answer<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: Failure };

type Meeting = MeetingChoices["meetings"][number];

/** The language a draft is written in: the view's own. */
function draftLanguage(language: string | undefined): "sv" | "en" {
  return language?.toLowerCase().startsWith("en") === true ? "en" : "sv";
}

function isReason(value: unknown): value is Reason {
  return (REASONS as readonly unknown[]).includes(value);
}

/** What a refusal's body says, as the view reads it. */
async function failureOf(response: Response): Promise<Failure> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A refusal without a body to read is answered by its status alone.
  }
  const { reason, retryAfterSeconds } =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  if (isReason(reason)) {
    return {
      kind: "refused",
      reason,
      retryAfterSeconds:
        typeof retryAfterSeconds === "number" &&
        Number.isInteger(retryAfterSeconds) &&
        retryAfterSeconds > 0
          ? retryAfterSeconds
          : null,
    };
  }
  return response.status === 403 ? { kind: "forbidden" } : { kind: "failed" };
}

/**
 * Calls a meeting support route. An answer that cannot be read is
 * `unanswered`: the request may have run all the same.
 */
async function call<Value>(
  path: string,
  init: RequestInit,
  read: (body: unknown) => Value | null,
): Promise<Answer<Value>> {
  let response: Response;
  try {
    response = await fetch(`${ROUTE}${path}`, {
      credentials: "same-origin",
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });
  } catch {
    return { ok: false, failure: { kind: "unanswered" } };
  }
  if (!response.ok) {
    const failure = await failureOf(response);
    // A fault, or a proxy's own answer, says nothing of whether the request
    // ran before it failed.
    return {
      ok: false,
      failure:
        failure.kind === "failed" && response.status >= 500
          ? { kind: "unanswered" }
          : failure,
    };
  }
  try {
    const value = read(await response.json());
    return value === null
      ? { ok: false, failure: { kind: "unanswered" } }
      : { ok: true, value };
  } catch {
    return { ok: false, failure: { kind: "unanswered" } };
  }
}

const isString = (value: unknown): value is string => typeof value === "string";

function meetingsOf(body: unknown): MeetingChoices | null {
  const { meetings, more } = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(meetings) || typeof more !== "boolean") {
    return null;
  }
  const read = meetings.filter(
    (meeting): meeting is Meeting =>
      typeof meeting === "object" &&
      meeting !== null &&
      isString((meeting as Meeting).id) &&
      ((meeting as Meeting).kind === "ORDINARY" ||
        (meeting as Meeting).kind === "EXTRAORDINARY") &&
      isString((meeting as Meeting).heldOn) &&
      typeof (meeting as Meeting).summoned === "boolean" &&
      typeof (meeting as Meeting).held === "boolean",
  );
  return read.length === meetings.length ? { meetings: read, more } : null;
}

function agendaOf(body: unknown): AgendaDraft | null {
  const { items, note, pendingChange } = (body ?? {}) as Record<
    string,
    unknown
  >;
  const change = (pendingChange ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(items) ||
    !items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        isString((item as { title?: unknown }).title),
    ) ||
    !isString(note) ||
    !isString(change.id) ||
    !isString(change.expiresAt) ||
    !isString(change.path)
  ) {
    return null;
  }
  return {
    items: items as AgendaDraft["items"],
    note,
    pendingChange: {
      id: change.id,
      expiresAt: change.expiresAt,
      path: change.path,
    },
  };
}

function minutesOf(body: unknown): MinutesDraft | null {
  const { draft, complete } = (body ?? {}) as Record<string, unknown>;
  return isString(draft) && typeof complete === "boolean"
    ? { draft, complete }
    : null;
}

/**
 * Where a link to the pending change goes: the path the platform gave, when
 * it is one on this origin, or else the pending changes screen itself.
 */
function pendingChangeHref(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")
    ? path
    : PENDING_CHANGES_PATH;
}

/** Stands for a date or a meeting in a translated sentence, to set it apart. */
const MARK = "\uE000";

/**
 * A translated sentence with `node` in place of its `MARK`. A date is
 * register data, set in the data face, and a sentence set in the UI face
 * cannot hold one.
 */
function fillIn(sentence: string, node: ReactNode): ReactElement {
  const at = sentence.indexOf(MARK);
  return at < 0 ? (
    <>
      {sentence} {node}
    </>
  ) : (
    <>
      {sentence.slice(0, at)}
      {node}
      {sentence.slice(at + MARK.length)}
    </>
  );
}

/** A date, in the data face. */
function Day({ children }: { children: string }): ReactElement {
  return <span style={styles.data}>{children}</span>;
}

/** The day a meeting is held, as the board member reads it. */
function useMeetingDay(): (meeting: Meeting) => string {
  const { i18n } = useTranslation(NAMESPACE);
  return (meeting) =>
    /^\d{4}-\d{2}-\d{2}$/.test(meeting.heldOn)
      ? new Intl.DateTimeFormat(i18n.language, {
          dateStyle: "long",
          timeZone: "UTC",
        }).format(new Date(`${meeting.heldOn}T00:00:00Z`))
      : meeting.heldOn;
}

/** The meeting as the board member knows it: its kind and its day. */
function useMeetingName(): (meeting: Meeting) => string {
  const { t } = useTranslation(NAMESPACE);
  const dayOf = useMeetingDay();
  return (meeting) =>
    t(`meetings.kind.${meeting.kind}`, { date: dayOf(meeting) });
}

/** The meeting's name as text of its own, with its day in the data face. */
function MeetingName({ meeting }: { meeting: Meeting }): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  const dayOf = useMeetingDay();
  return fillIn(
    t(`meetings.kind.${meeting.kind}`, { date: MARK }),
    <Day>{dayOf(meeting)}</Day>,
  );
}

function FailureNotice({
  failure,
  unanswered,
}: {
  failure: Failure;
  unanswered:
    | "meetings.error.agendaUnanswered"
    | "meetings.error.listUnanswered"
    | "meetings.error.unanswered";
}): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  switch (failure.kind) {
    case "unanswered":
      return (
        <p role="alert" style={styles.failed}>
          {t(unanswered)}
        </p>
      );
    case "forbidden":
      return (
        <p role="alert" style={styles.failed}>
          {t("meetings.error.forbidden")}
        </p>
      );
    case "failed":
      return (
        <p role="alert" style={styles.failed}>
          {t("meetings.error.failed")}
        </p>
      );
    case "refused":
      return (
        <p role="alert" style={styles.failed}>
          {failure.reason === "rate-limited" &&
          failure.retryAfterSeconds !== null
            ? t("meetings.refused.rate-limited-after", {
                count: failure.retryAfterSeconds,
              })
            : t(`meetings.refused.${failure.reason}`)}
        </p>
      );
  }
}

function PendingChangesLink(): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  return (
    <a href={PENDING_CHANGES_PATH} style={styles.link}>
      {t("meetings.agenda.pendingChanges")}
    </a>
  );
}

type AgendaState =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | {
      readonly status: "drafted";
      readonly meeting: Meeting;
      readonly draft: AgendaDraft;
    }
  | {
      readonly status: "failed";
      readonly meeting: Meeting;
      readonly failure: Failure;
    };

function AgendaDraftForm({
  meetings,
}: {
  meetings: readonly Meeting[];
}): ReactElement {
  const { t, i18n } = useTranslation(NAMESPACE);
  const nameOf = useMeetingName();
  const arranged = meetings.filter(
    (meeting) => !meeting.summoned && !meeting.held,
  );
  const [meetingId, setMeetingId] = useState(arranged[0]?.id ?? "");
  const [instructions, setInstructions] = useState("");
  const [state, setState] = useState<AgendaState>({ status: "idle" });
  const latest = useRef(0);
  const inFlight = useRef(false);
  // Counts the changes to what is asked, to tell a refusal of what is still
  // on the screen from one of what has been changed since.
  const inputs = useRef(0);

  useEffect(
    () => () => {
      // An answer that arrives after the view has closed has nowhere to go.
      latest.current += 1;
    },
    [],
  );

  const chosen = arranged.find((meeting) => meeting.id === meetingId);

  /**
   * A refusal belongs to what was asked, so a new choice clears it, and one
   * that arrives later is dropped. An answer that never came stays: a
   * proposal may exist for the meeting it was asked for.
   */
  const changed = (): void => {
    inputs.current += 1;
    setState((current) =>
      current.status === "failed" && current.failure.kind !== "unanswered"
        ? { status: "idle" }
        : current,
    );
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (inFlight.current || chosen === undefined) {
      return;
    }
    inFlight.current = true;
    const request = ++latest.current;
    const meeting = chosen;
    const revision = inputs.current;
    setState({ status: "sending" });
    const asked = instructions.trim();
    const answer = await call(
      `/${encodeURIComponent(meeting.id)}/agenda-draft`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(asked === "" ? {} : { instructions: asked }),
          language: draftLanguage(i18n.language),
        }),
      },
      agendaOf,
    );
    inFlight.current = false;
    if (request !== latest.current) {
      return;
    }
    if (
      !answer.ok &&
      answer.failure.kind !== "unanswered" &&
      revision !== inputs.current
    ) {
      setState({ status: "idle" });
      return;
    }
    setState(
      answer.ok
        ? { status: "drafted", meeting, draft: answer.value }
        : { status: "failed", meeting, failure: answer.failure },
    );
  };

  const sending = state.status === "sending";

  return (
    <div style={styles.assistant}>
      <h4 style={styles.subheading}>{t("meetings.agenda.heading")}</h4>
      <p style={styles.muted}>{t("meetings.agenda.intro")}</p>
      {arranged.length === 0 ? (
        <p style={styles.notice}>{t("meetings.agenda.noneArranged")}</p>
      ) : (
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          style={styles.form}
        >
          <label htmlFor="ai-package-agenda-meeting" style={styles.label}>
            {t("meetings.agenda.meetingLabel")}
          </label>
          <select
            id="ai-package-agenda-meeting"
            value={meetingId}
            style={styles.select}
            onChange={(event) => {
              setMeetingId(event.target.value);
              changed();
            }}
          >
            {arranged.map((meeting) => (
              <option key={meeting.id} value={meeting.id}>
                {nameOf(meeting)}
              </option>
            ))}
          </select>
          <label htmlFor="ai-package-agenda-request" style={styles.label}>
            {t("meetings.agenda.requestLabel")}
          </label>
          <p id="ai-package-agenda-request-hint" style={styles.muted}>
            {t("meetings.agenda.requestHint")}
          </p>
          <textarea
            id="ai-package-agenda-request"
            aria-describedby="ai-package-agenda-request-hint"
            value={instructions}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            rows={3}
            style={styles.textarea}
            onChange={(event) => {
              setInstructions(event.target.value);
              changed();
            }}
          />
          <div style={styles.toolbar}>
            <button
              type="submit"
              style={{ ...styles.button, ...styles.primary }}
              disabled={sending || chosen === undefined}
            >
              {t("meetings.agenda.submit")}
            </button>
          </div>
        </form>
      )}

      {sending ? (
        <p role="status" style={styles.muted}>
          {t("meetings.agenda.working")}
        </p>
      ) : null}

      {state.status === "failed" ? (
        <div style={styles.toolbar}>
          {state.failure.kind === "unanswered" ? (
            // The meeting may no longer be the one chosen above.
            <p style={styles.who}>
              {fillIn(
                t("meetings.agenda.askedFor", { meeting: MARK }),
                <MeetingName meeting={state.meeting} />,
              )}
            </p>
          ) : null}
          <FailureNotice
            failure={state.failure}
            unanswered="meetings.error.agendaUnanswered"
          />
          {state.failure.kind === "unanswered" ? <PendingChangesLink /> : null}
        </div>
      ) : null}

      {state.status === "drafted" ? (
        <AgendaResult meeting={state.meeting} draft={state.draft} />
      ) : null}
    </div>
  );
}

function AgendaResult({
  meeting,
  draft,
}: {
  meeting: Meeting;
  draft: AgendaDraft;
}): ReactElement {
  const { t, i18n } = useTranslation(NAMESPACE);
  const expires = new Date(draft.pendingChange.expiresAt);
  return (
    <section style={styles.entry} aria-live="polite">
      <p style={styles.proposalsHeading}>
        {fillIn(
          t("meetings.agenda.resultHeading", { meeting: MARK }),
          <MeetingName meeting={meeting} />,
        )}
      </p>
      <ol style={styles.items}>
        {draft.items.map((item, index) => (
          // Two items may carry the same title, so the position keys them.
          <li key={index} style={styles.text}>
            {item.title}
          </li>
        ))}
      </ol>
      {draft.note.trim() === "" ? null : (
        <>
          <p style={styles.who}>{t("meetings.agenda.noteHeading")}</p>
          <p style={styles.text}>{draft.note}</p>
        </>
      )}
      <div style={styles.proposals}>
        <p style={styles.muted}>{t("meetings.agenda.confirmThere")}</p>
        <div style={styles.proposal}>
          <a
            href={pendingChangeHref(draft.pendingChange.path)}
            style={styles.link}
          >
            {t("meetings.agenda.open")}
          </a>
          {Number.isNaN(expires.getTime()) ? null : (
            <span style={styles.muted}>
              {fillIn(
                t("meetings.agenda.expires", { date: MARK }),
                <Day>
                  {new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: "long",
                  }).format(expires)}
                </Day>,
              )}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

type MinutesState =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | {
      readonly status: "drafted";
      readonly meeting: Meeting;
      readonly notes: string;
      readonly draft: MinutesDraft;
    }
  | {
      readonly status: "failed";
      readonly meeting: Meeting;
      readonly failure: Failure;
    };

type Copied = "copied" | "copyFailed" | null;

function MinutesDraftForm({
  meetings,
}: {
  meetings: readonly Meeting[];
}): ReactElement {
  const { t, i18n } = useTranslation(NAMESPACE);
  const nameOf = useMeetingName();
  // A meeting is usually minuted after it is held, so the latest held one
  // comes first.
  const [meetingId, setMeetingId] = useState(
    (meetings.find((meeting) => meeting.held) ?? meetings[0])?.id ?? "",
  );
  const [notes, setNotes] = useState("");
  const [state, setState] = useState<MinutesState>({ status: "idle" });
  const [copied, setCopied] = useState<Copied>(null);
  const latest = useRef(0);
  const inFlight = useRef(false);
  // As in the agenda form: a refusal of what has been changed since is dropped.
  const inputs = useRef(0);

  useEffect(
    () => () => {
      latest.current += 1;
    },
    [],
  );

  const chosen = meetings.find((meeting) => meeting.id === meetingId);

  const changed = (): void => {
    inputs.current += 1;
    setState((current) =>
      current.status === "failed" ? { status: "idle" } : current,
    );
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const sent = notes.trim();
    if (inFlight.current || chosen === undefined || sent === "") {
      return;
    }
    inFlight.current = true;
    const request = ++latest.current;
    const meeting = chosen;
    const revision = inputs.current;
    setState({ status: "sending" });
    setCopied(null);
    const answer = await call(
      `/${encodeURIComponent(meeting.id)}/minutes-draft`,
      {
        method: "POST",
        body: JSON.stringify({
          notes: sent,
          language: draftLanguage(i18n.language),
        }),
      },
      minutesOf,
    );
    inFlight.current = false;
    if (request !== latest.current) {
      return;
    }
    // A draft is kept, and the notes it was written from are noted as
    // changed. Nothing is kept of a failure: asking again costs nothing.
    if (!answer.ok && revision !== inputs.current) {
      setState({ status: "idle" });
      return;
    }
    setState(
      answer.ok
        ? { status: "drafted", meeting, notes: sent, draft: answer.value }
        : { status: "failed", meeting, failure: answer.failure },
    );
  };

  const copy = async (text: string): Promise<void> => {
    const request = latest.current;
    let outcome: Copied;
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("No clipboard.");
      }
      await navigator.clipboard.writeText(text);
      outcome = "copied";
    } catch {
      outcome = "copyFailed";
    }
    // A newer draft has taken the place of the one that was copied.
    if (request === latest.current) {
      setCopied(outcome);
    }
  };

  const sending = state.status === "sending";

  return (
    <div style={styles.assistant}>
      <h4 style={styles.subheading}>{t("meetings.minutes.heading")}</h4>
      <p style={styles.muted}>{t("meetings.minutes.intro")}</p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        style={styles.form}
      >
        <label htmlFor="ai-package-minutes-meeting" style={styles.label}>
          {t("meetings.minutes.meetingLabel")}
        </label>
        <select
          id="ai-package-minutes-meeting"
          value={meetingId}
          style={styles.select}
          onChange={(event) => {
            setMeetingId(event.target.value);
            changed();
          }}
        >
          {meetings.map((meeting) => (
            <option key={meeting.id} value={meeting.id}>
              {meeting.held
                ? t("meetings.state.held", { meeting: nameOf(meeting) })
                : meeting.summoned
                  ? t("meetings.state.summoned", { meeting: nameOf(meeting) })
                  : t("meetings.state.arranged", { meeting: nameOf(meeting) })}
            </option>
          ))}
        </select>
        <label htmlFor="ai-package-minutes-notes" style={styles.label}>
          {t("meetings.minutes.notesLabel")}
        </label>
        <textarea
          id="ai-package-minutes-notes"
          value={notes}
          maxLength={MAX_NOTES_LENGTH}
          rows={10}
          style={styles.textarea}
          onChange={(event) => {
            setNotes(event.target.value);
            changed();
          }}
        />
        <div style={styles.toolbar}>
          <button
            type="submit"
            style={{ ...styles.button, ...styles.primary }}
            disabled={sending || chosen === undefined || notes.trim() === ""}
          >
            {t("meetings.minutes.submit")}
          </button>
        </div>
      </form>

      {sending ? (
        <p role="status" style={styles.muted}>
          {t("meetings.minutes.working")}
        </p>
      ) : null}

      {state.status === "failed" ? (
        <FailureNotice
          failure={state.failure}
          unanswered="meetings.error.unanswered"
        />
      ) : null}

      {state.status === "drafted" ? (
        <section style={styles.entry} aria-live="polite">
          <label htmlFor="ai-package-minutes-draft" style={styles.label}>
            {fillIn(
              t("meetings.minutes.resultHeading", { meeting: MARK }),
              <MeetingName meeting={state.meeting} />,
            )}
          </label>
          {state.draft.complete ? null : (
            <p style={styles.notice}>{t("meetings.minutes.cutShort")}</p>
          )}
          {state.notes === notes.trim() ? null : (
            <p style={styles.notice}>{t("meetings.minutes.notesChanged")}</p>
          )}
          <textarea
            id="ai-package-minutes-draft"
            readOnly
            value={state.draft.draft}
            rows={16}
            style={styles.textarea}
          />
          <div style={styles.toolbar}>
            <button
              type="button"
              style={styles.button}
              onClick={() => {
                void copy(state.draft.draft);
              }}
            >
              {t("meetings.minutes.copy")}
            </button>
            {copied === null ? null : (
              <p
                role={copied === "copied" ? "status" : "alert"}
                style={copied === "copied" ? styles.muted : styles.failed}
              >
                {t(`meetings.minutes.${copied}`)}
              </p>
            )}
          </div>
          <p style={styles.muted}>{t("meetings.minutes.notKept")}</p>
        </section>
      ) : null}
    </div>
  );
}

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly meetings: MeetingChoices }
  | { readonly status: "failed"; readonly failure: Failure };

export default function MeetingSupport(): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  const [list, setList] = useState<ListState>({ status: "loading" });
  const latest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    setList({ status: "loading" });
    const answer = await call("", { method: "GET" }, meetingsOf);
    if (request !== latest.current) {
      return;
    }
    setList(
      answer.ok
        ? { status: "loaded", meetings: answer.value }
        : { status: "failed", failure: answer.failure },
    );
  }, []);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  return (
    <div style={styles.assistant}>
      <h3 style={styles.subheading}>{t("meetings.heading")}</h3>
      <p style={styles.muted}>{t("meetings.intro")}</p>

      {list.status === "loading" ? (
        <p role="status" style={styles.muted}>
          {t("meetings.loading")}
        </p>
      ) : null}

      {list.status === "failed" ? (
        <div style={styles.toolbar}>
          <FailureNotice
            failure={list.failure}
            unanswered="meetings.error.listUnanswered"
          />
          <button
            type="button"
            style={styles.button}
            onClick={() => {
              void load();
            }}
          >
            {t("meetings.reload")}
          </button>
        </div>
      ) : null}

      {list.status === "loaded" && list.meetings.meetings.length === 0 ? (
        <p style={styles.notice}>{t("meetings.none")}</p>
      ) : null}

      {list.status === "loaded" && list.meetings.meetings.length > 0 ? (
        <>
          <AgendaDraftForm meetings={list.meetings.meetings} />
          <MinutesDraftForm meetings={list.meetings.meetings} />
        </>
      ) : null}
    </div>
  );
}
