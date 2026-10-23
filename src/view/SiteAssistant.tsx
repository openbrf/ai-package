import {
  type CSSProperties,
  type FormEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  MAX_ANSWER_LENGTH,
  MAX_CONVERSATION_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES,
} from "../assistant/limits.ts";
// Types only: a value from the server's modules would take them into the
// browser's bundle.
import type {
  ConversationMessage,
  SiteTurnResponse,
} from "../assistant/site-assistant.ts";
import type { Proposal } from "../assistant/tool-loop.ts";
import { NAMESPACE, styles } from "./styles.ts";

/**
 * The site and news assistant's conversation.
 *
 * What the person writes goes to the package's own route with the
 * conversation so far, and the model's answer comes back with the pending
 * changes it proposed. Each is a link to the platform's own pending changes
 * screen, where the person reads the change field by field and confirms or
 * rejects it: this view confirms nothing and has no button that could.
 *
 * One turn at a time. A turn that got no answer, because the connection
 * failed, is sent again under the same id, so the route runs it once
 * however many times it arrives.
 */

const ROUTE = "/api/plugin/ai-package/assistants/site/turns";

type Notice =
  | "outcome.cutShort"
  | "outcome.tooManyRounds"
  | "outcome.declined"
  | "outcome.failed"
  | "outcome.repeated"
  | "outcome.inProgress"
  | `refused.${string}`;

type Entry =
  | { readonly kind: "person"; readonly key: string; readonly text: string }
  | {
      readonly kind: "reply";
      readonly key: string;
      readonly text: string | null;
      readonly notice: Notice | null;
      readonly proposals: readonly Proposal[];
    };

/** A turn on its way, or one that got no answer and can be sent again. */
interface Turn {
  readonly turnId: string;
  readonly text: string;
}

type Failure = "send" | "forbidden";

/** The reply an answer from the route is shown as. */
function replyOf(response: SiteTurnResponse, key: string): Entry {
  const reply = (
    text: string | null,
    notice: Notice | null,
    proposals: readonly Proposal[] = [],
  ): Entry => ({ kind: "reply", key, text, notice, proposals });
  switch (response.outcome) {
    case "answered":
      return reply(response.answer || null, null, response.proposals);
    case "cut-short":
      return reply(
        response.answer || null,
        "outcome.cutShort",
        response.proposals,
      );
    case "too-many-rounds":
      return reply(null, "outcome.tooManyRounds", response.proposals);
    case "declined":
      return reply(null, "outcome.declined", response.proposals);
    case "failed":
      return reply(null, "outcome.failed", response.proposals);
    case "refused":
      return reply(null, `refused.${response.reason}`, response.proposals);
    case "repeated":
      return reply(null, "outcome.repeated", response.proposals);
    case "in-progress":
      return reply(null, "outcome.inProgress");
    case "host-unsupported":
      return reply(null, "refused.host-unsupported");
  }
}

/**
 * The conversation the route is sent: every exchange the model answered in
 * words, the newest that fit within the route's limits, and then what the
 * person asks now. An exchange without an answer, refused or failed, is left
 * out, so the conversation still alternates.
 */
export function conversationFor(
  entries: readonly Entry[],
  text: string,
): ConversationMessage[] {
  const exchanges: [ConversationMessage, ConversationMessage][] = [];
  for (let index = 0; index + 1 < entries.length; index++) {
    const asked = entries[index];
    const answered = entries[index + 1];
    if (
      asked?.kind === "person" &&
      answered?.kind === "reply" &&
      answered.text !== null
    ) {
      exchanges.push([
        { role: "user", text: asked.text },
        { role: "assistant", text: answered.text.slice(0, MAX_ANSWER_LENGTH) },
      ]);
    }
  }
  const kept: ConversationMessage[] = [];
  let length = text.length;
  for (const exchange of exchanges.reverse()) {
    const size = exchange[0].text.length + exchange[1].text.length;
    if (
      kept.length + 3 > MAX_MESSAGES ||
      length + size > MAX_CONVERSATION_LENGTH
    ) {
      break;
    }
    kept.unshift(...exchange);
    length += size;
  }
  return [...kept, { role: "user", text }];
}

function ProposalList({
  proposals,
}: {
  proposals: readonly Proposal[];
}): ReactElement {
  const { t, i18n } = useTranslation(NAMESPACE);
  const date = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "long",
  });
  return (
    <div style={styles.proposals}>
      <p style={styles.proposalsHeading}>{t("site.proposals.heading")}</p>
      <ul style={styles.list}>
        {proposals.map((proposal) => (
          <li key={proposal.id} style={styles.proposal}>
            <a href={proposal.path} style={styles.link}>
              {t("site.proposals.open", { title: proposal.title })}
            </a>
            <span style={styles.muted}>
              {t("site.proposals.expires", {
                date: date.format(new Date(proposal.expiresAt)),
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EntryView({ entry }: { entry: Entry }): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  if (entry.kind === "person") {
    return (
      <li style={{ ...styles.entry, ...styles.person }}>
        <p style={styles.who}>{t("site.you")}</p>
        <p style={styles.text}>{entry.text}</p>
      </li>
    );
  }
  const warn: CSSProperties =
    entry.notice?.startsWith("refused.") === true ||
    entry.notice === "outcome.failed"
      ? styles.failed
      : styles.notice;
  return (
    <li style={styles.entry}>
      <p style={styles.who}>{t("site.assistant")}</p>
      {entry.text === null ? null : <p style={styles.text}>{entry.text}</p>}
      {entry.notice === null ? null : (
        <p style={warn}>{t(`site.${entry.notice}`)}</p>
      )}
      {entry.proposals.length === 0 ? null : (
        <ProposalList proposals={entry.proposals} />
      )}
    </li>
  );
}

export default function SiteAssistant(): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<Turn | null>(null);
  const [unsent, setUnsent] = useState<Turn | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const mounted = useRef(true);
  const keys = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const nextKey = (): string => {
    keys.current += 1;
    return `entry-${String(keys.current)}`;
  };

  const send = async (turn: Turn, history: readonly Entry[]): Promise<void> => {
    setSending(turn);
    setUnsent(null);
    setFailure(null);
    let response: Response;
    try {
      response = await fetch(ROUTE, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          turnId: turn.turnId,
          messages: conversationFor(history, turn.text),
        }),
      });
    } catch {
      if (mounted.current) {
        setSending(null);
        setUnsent(turn);
        setFailure("send");
      }
      return;
    }
    if (!mounted.current) {
      return;
    }
    if (response.status === 403) {
      setSending(null);
      setFailure("forbidden");
      return;
    }
    let answer: SiteTurnResponse;
    try {
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
      answer = (await response.json()) as SiteTurnResponse;
    } catch {
      // No answer to read. The turn may have run, so it is offered again
      // under the same id: the route then says what it proposed.
      if (mounted.current) {
        setSending(null);
        setUnsent(turn);
        setFailure("send");
      }
      return;
    }
    if (!mounted.current) {
      return;
    }
    setSending(null);
    setEntries((current) => [...current, replyOf(answer, nextKey())]);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "" || sending !== null || unsent !== null) {
      return;
    }
    const history = entries;
    setEntries([...history, { kind: "person", key: nextKey(), text }]);
    setDraft("");
    void send({ turnId: crypto.randomUUID(), text }, history);
  };

  const retry = (): void => {
    if (unsent === null || sending !== null) {
      return;
    }
    // The person's message is the last entry; the conversation before it is
    // what the turn was first sent with.
    void send(unsent, entries.slice(0, -1));
  };

  const restart = (): void => {
    if (sending !== null) {
      return;
    }
    setEntries([]);
    setDraft("");
    setUnsent(null);
    setFailure(null);
  };

  const busy = sending !== null;

  return (
    <div style={styles.assistant}>
      <h3 style={styles.subheading}>{t("site.heading")}</h3>
      <p style={styles.muted}>{t("site.intro")}</p>
      <p style={styles.muted}>{t("site.mailingNote")}</p>

      {entries.length === 0 ? null : (
        <ol style={styles.list} aria-live="polite">
          {entries.map((entry) => (
            <EntryView key={entry.key} entry={entry} />
          ))}
        </ol>
      )}

      {busy ? (
        <p role="status" style={styles.muted}>
          {t("site.working")}
        </p>
      ) : null}

      {failure === null ? null : (
        <div style={styles.toolbar}>
          <p role="alert" style={styles.failed}>
            {t(`site.error.${failure}`)}
          </p>
          {unsent === null ? null : (
            <button
              type="button"
              style={styles.button}
              onClick={retry}
              disabled={busy}
            >
              {t("site.retry")}
            </button>
          )}
        </div>
      )}

      <form onSubmit={submit} style={styles.form}>
        <label htmlFor="ai-package-site-prompt" style={styles.label}>
          {t("site.promptLabel")}
        </label>
        <textarea
          id="ai-package-site-prompt"
          value={draft}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={4}
          style={styles.textarea}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <div style={styles.toolbar}>
          <button
            type="submit"
            style={{ ...styles.button, ...styles.primary }}
            disabled={busy || unsent !== null || draft.trim() === ""}
          >
            {t("site.send")}
          </button>
          <button
            type="button"
            style={styles.button}
            onClick={restart}
            disabled={busy || entries.length === 0}
          >
            {t("site.newConversation")}
          </button>
        </div>
      </form>
    </div>
  );
}
