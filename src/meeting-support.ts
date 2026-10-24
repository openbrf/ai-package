import type { ActionRequest } from "@openbrf/plugin-sdk";
import { z } from "zod";

import type { AiGateway } from "./gateway.ts";
import type { AiPackageHost, PluginDisclosure } from "./host-contract.ts";
import {
  AGENDA_OUTPUT_SCHEMA,
  agendaInput,
  agendaPrompt,
  agendaSystem,
  minutesInput,
  minutesPrompt,
  minutesSystem,
  MOTION_ITEM_LIMIT,
} from "./meeting-prompts.ts";
import type { Language } from "./messages.ts";
import { holdsPersonalIdentityNumber } from "./personal-identity-number.ts";
import type { ModelResponse } from "./provider.ts";

/**
 * Meeting support: an agenda draft and a minutes draft for a general meeting
 * (föreningsstämma), for the board member who asks.
 *
 * Both read the meeting through the core's own actions, `meeting_list` and
 * `meeting_get`, which carry the agenda, the decisions as totals and the
 * notice's terms and never a person (ADR 0041 in openbrf/openbrf). An agenda
 * draft also reads the motions put to the meeting through
 * `motion_meeting_list`, which carries each motion's title and whether the
 * board has acknowledged it and never who submitted it (ADR 0038). The model
 * is offered no tools: it reads what the package hands it and answers with a
 * draft, so text in a meeting's record, a motion's title or the notes can
 * change a draft and nothing else.
 *
 * - An agenda draft is proposed as `meeting_set_agenda`, a pending change the
 *   person who asked confirms or rejects on the platform's own screen (ADR
 *   0039). The package writes nothing itself and keeps no copy of the draft.
 *   The proposal names the agenda it was drafted against, so a draft
 *   confirmed after somebody rewrote the agenda is refused, not written over.
 * - A minutes draft is text handed back to the board member, from the notes
 *   they took. It is not stored, here or in the archive: the minutes are
 *   signed and filed by the board, as before.
 */

/**
 * Why meeting support has no draft, beyond the gateway's own refusals and the
 * host's refusals of the actions it calls.
 *
 * - `host-unsupported`: the instance is older than meeting support, and has
 *   no `meeting_get`, `meeting_set_agenda` or pending changes.
 * - `notice-already-issued`: the notice is out, so the agenda is settled.
 * - `meeting-already-held`: the meeting is recorded as held.
 * - `no-draft`: the model declined, ran out of room, or answered with
 *   something that is not a draft. Nothing was proposed.
 * - `personal-identity-number`: the request, the notes or the meeting's
 *   record hold a personal identity number, which is not sent to the model
 *   provider. The record is the agenda's titles, the previous meeting's
 *   agenda and the notice's place and digital participation.
 */
export type MeetingSupportReason =
  | "host-unsupported"
  | "notice-already-issued"
  | "meeting-already-held"
  | "no-draft"
  | "personal-identity-number";

export class MeetingSupportRefusal extends Error {
  constructor(readonly reason: MeetingSupportReason) {
    super(`Meeting support has no draft: ${reason}.`);
    this.name = "MeetingSupportRefusal";
  }
}

export interface AgendaDraft {
  readonly items: readonly { readonly title: string }[];
  /** What the model based the draft on and what to check, for the board. */
  readonly note: string;
  readonly pendingChange: {
    readonly id: string;
    /** ISO instant. */
    readonly expiresAt: string;
    /** Where the board member confirms or rejects it. */
    readonly path: string;
  };
}

/**
 * The meetings the board's screen offers to draft for, as `meeting_list`
 * answers with them: the one furthest ahead first. `summoned` and `held` say
 * which can still have their agenda drafted: one with neither.
 */
export interface MeetingChoices {
  readonly meetings: readonly {
    readonly id: string;
    readonly kind: "ORDINARY" | "EXTRAORDINARY";
    /** The day it is held, as an ISO date. */
    readonly heldOn: string;
    /** Whether the notice is out, which settles the agenda. */
    readonly summoned: boolean;
    /** Whether it is recorded as held. */
    readonly held: boolean;
  }[];
  /** Whether older meetings were left out. */
  readonly more: boolean;
}

export interface MinutesDraft {
  readonly draft: string;
  /** False when the draft was cut short at the length the package allows. */
  readonly complete: boolean;
}

/** The most items an agenda holds, as `meeting_set_agenda` takes them. */
const MAX_AGENDA_ITEMS = 100;

/** The longest title an agenda item has, as `meeting_set_agenda` takes it. */
const MAX_TITLE_LENGTH = 300;

/**
 * What either draft sends: text people wrote, in the agenda's titles, the
 * notice's place, the request and the notes, which the board wrote, and the
 * titles of the motions members put to the meeting. None of it is held to a form, so
 * it can carry every category the manifest declares: the names of members who
 * spoke, were elected or put a motion, their apartments, and what residents
 * said about their health. Nobody in it is known by an id, so the host records
 * the disclosure once, with no person.
 */
const MEETING_DISCLOSURE: PluginDisclosure = {
  personalData: ["name", "apartment", "freeText", "health"],
  subjects: [],
};

const decisionSchema = z
  .object({
    outcome: z.enum(["CARRIED", "REJECTED"]),
    votesFor: z.number().int(),
    votesAgainst: z.number().int(),
    votesAbstaining: z.number().int(),
    closedBallot: z.boolean(),
  })
  .nullable();

/** What `meeting_get` answers with, as far as meeting support reads it. */
const meetingSchema = z.object({
  id: z.string(),
  kind: z.enum(["ORDINARY", "EXTRAORDINARY"]),
  heldOn: z.string(),
  concludedAt: z.string().nullable(),
  summoned: z.boolean(),
  agenda: z.array(
    z.object({
      id: z.string(),
      position: z.number().int(),
      title: z.string(),
      decision: decisionSchema,
    }),
  ),
  notice: z
    .object({
      startsAt: z.string(),
      place: z.string(),
      digitalParticipation: z.string().nullable(),
    })
    .nullable(),
});

export type Meeting = z.infer<typeof meetingSchema>;

/** What `meeting_list` answers with, as far as meeting support reads it. */
const meetingListSchema = z.object({
  meetings: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["ORDINARY", "EXTRAORDINARY"]),
      heldOn: z.string(),
      concludedAt: z.string().nullable(),
    }),
  ),
  more: z.boolean(),
});

/** What `meeting_list` answers with, as the board's screen lists it. */
const meetingChoicesSchema = z.object({
  meetings: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["ORDINARY", "EXTRAORDINARY"]),
      heldOn: z.string(),
      concludedAt: z.string().nullable(),
      summoned: z.boolean(),
    }),
  ),
  more: z.boolean(),
});

/**
 * What `motion_meeting_list` answers with, as far as meeting support reads it.
 * The motion's id is not read: the model has no use for it.
 */
const meetingMotionsSchema = z.object({
  motions: z.array(
    z.object({
      title: z.string(),
      status: z.enum(["SUBMITTED", "ACKNOWLEDGED"]),
    }),
  ),
  more: z.boolean(),
});

/**
 * The motions put to a meeting as the model is handed them, or null where the
 * package could not read them: on a host without `motion_meeting_list`, or for
 * a board member who does not hold `motions:handle`, which the host's listing
 * leaves the action out for.
 */
export type MeetingMotions = {
  readonly motions: readonly {
    readonly title: string;
    readonly acknowledged: boolean;
  }[];
  /**
   * Whether motions were left out: by the host to keep to its limit, or by
   * the package to leave room in the agenda for the meeting's other matters.
   */
  readonly more: boolean;
} | null;

type MeetingSummary = z.infer<typeof meetingListSchema>["meetings"][number];

/** The most meetings `meeting_list` answers with at once. */
const MEETINGS_PER_LIST = 50;

/** The first year `meeting_list` takes. */
const FIRST_LISTED_YEAR = 1900;

/** The model's agenda, checked as `meeting_set_agenda` will check it. */
const agendaAnswerSchema = z.object({
  items: z
    .array(z.object({ title: z.string().trim().min(1).max(MAX_TITLE_LENGTH) }))
    .min(1)
    .max(MAX_AGENDA_ITEMS),
  note: z.string().trim(),
});

/** The core actions each draft needs, and that an older host may lack. */
const AGENDA_ACTIONS = ["meeting_list", "meeting_get", "meeting_set_agenda"];
const MINUTES_ACTIONS = ["meeting_get"];

/**
 * The read an agenda draft uses where the host offers it, and does without
 * where it does not: the draft then says where the motions belong.
 */
const MOTIONS_ACTION = "motion_meeting_list";

export class MeetingSupport {
  constructor(
    private readonly host: AiPackageHost,
    private readonly gateway: AiGateway,
  ) {}

  /**
   * The most recent fifty meetings, for the board member to choose the one a
   * draft is for. Nothing in it goes to the model.
   */
  async meetings(request: ActionRequest): Promise<MeetingChoices> {
    await this.requireActions(request, ["meeting_list"]);
    const listed = meetingChoicesSchema.parse(
      await this.host.actions.invoke(request, "meeting_list", {
        limit: MEETINGS_PER_LIST,
      }),
    );
    return {
      meetings: listed.meetings.map((meeting) => ({
        id: meeting.id,
        kind: meeting.kind,
        heldOn: meeting.heldOn,
        summoned: meeting.summoned,
        held: meeting.concludedAt !== null,
      })),
      more: listed.more,
    };
  }

  /**
   * Drafts the meeting's agenda and proposes it for the board member to
   * confirm.
   *
   * Refused before any call to the model once the notice is out or the
   * meeting is held, since the agenda can then no longer be set. The draft
   * starts from the agenda of the last meeting of the same kind that was held,
   * where there is one, and lists the motions put to the meeting where the
   * host lets the package read them.
   */
  async draftAgenda(
    request: ActionRequest,
    meetingId: string,
    options: {
      readonly instructions: string | null;
      readonly language: Language;
    },
  ): Promise<AgendaDraft> {
    refuseIdentityNumbers(options.instructions);
    const { actions } = this.host;
    if (actions.propose === undefined) {
      throw new MeetingSupportRefusal("host-unsupported");
    }
    const offered = await this.requireActions(request, AGENDA_ACTIONS);

    const meeting = await this.readMeeting(request, meetingId);
    if (meeting.concludedAt !== null) {
      throw new MeetingSupportRefusal("meeting-already-held");
    }
    if (meeting.summoned) {
      throw new MeetingSupportRefusal("notice-already-issued");
    }
    const previous = await this.previousMeeting(request, meeting);
    const motions = offered.has(MOTIONS_ACTION)
      ? await this.readMotions(request, meeting.id)
      : null;
    const input = agendaInput(meeting, previous, motions, options.instructions);
    refuseIdentityNumbers(input);

    const response = await this.gateway.complete(
      {
        system: agendaSystem(options.language),
        messages: [{ role: "user", content: agendaPrompt(input) }],
        maxOutputTokens: 16_000,
        effort: "low",
        outputSchema: AGENDA_OUTPUT_SCHEMA,
      },
      MEETING_DISCLOSURE,
    );
    const answer = agendaAnswer(response);

    const receipt = await actions.propose(request, "meeting_set_agenda", {
      meetingId: meeting.id,
      expectedItemIds: meeting.agenda.map((item) => item.id),
      items: answer.items,
    });
    return {
      items: answer.items,
      note: answer.note,
      pendingChange: {
        id: receipt.id,
        expiresAt: new Date(receipt.expiresAt).toISOString(),
        path: receipt.path,
      },
    };
  }

  /**
   * Drafts the minutes from the board member's notes and the meeting's
   * record: its agenda, the decisions as recorded and the notice's terms.
   *
   * Handed back and kept nowhere. A draft cut short at the length allowed
   * comes back as it is, marked as not complete.
   */
  async draftMinutes(
    request: ActionRequest,
    meetingId: string,
    options: { readonly notes: string; readonly language: Language },
  ): Promise<MinutesDraft> {
    refuseIdentityNumbers(options.notes);
    await this.requireActions(request, MINUTES_ACTIONS);
    const meeting = await this.readMeeting(request, meetingId);
    const input = minutesInput(meeting, options.notes);
    refuseIdentityNumbers(input);

    const response = await this.gateway.complete(
      {
        system: minutesSystem(options.language),
        messages: [{ role: "user", content: minutesPrompt(input) }],
        maxOutputTokens: 32_000,
        effort: "medium",
        // A long meeting's minutes take a while to write, and the host waits
        // no longer than this on a recipient.
        timeoutMs: 300_000,
      },
      MEETING_DISCLOSURE,
    );
    if (response.stop === "refusal") {
      throw new MeetingSupportRefusal("no-draft");
    }
    const draft = textOf(response).trim();
    if (draft === "") {
      throw new MeetingSupportRefusal("no-draft");
    }
    return { draft, complete: response.stop !== "max-tokens" };
  }

  /**
   * Refuses on a host without the core actions a draft needs, before the
   * model is called and the month's tokens spent on a draft that could not be
   * proposed. The route requires `meetings:manage`, which the three actions
   * require, so an action missing here is one the host does not offer.
   *
   * Answers with every action the host offers this board member, so a draft
   * can tell whether it may also read one it does without where it must.
   */
  private async requireActions(
    request: ActionRequest,
    names: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const offered = new Set(
      (await this.host.actions.list(request)).map((action) => action.name),
    );
    if (names.some((name) => !offered.has(name))) {
      throw new MeetingSupportRefusal("host-unsupported");
    }
    return offered;
  }

  /**
   * The motions put to the meeting, by `motion_meeting_list`: each one's title
   * and whether the board has acknowledged it, and nothing about who submitted
   * it, which the action does not carry. Its refusals reach the route as they
   * are.
   */
  private async readMotions(
    request: ActionRequest,
    meetingId: string,
  ): Promise<MeetingMotions> {
    const read = meetingMotionsSchema.parse(
      await this.host.actions.invoke(request, MOTIONS_ACTION, { meetingId }),
    );
    return {
      motions: read.motions.slice(0, MOTION_ITEM_LIMIT).map((motion) => ({
        title: motion.title,
        acknowledged: motion.status === "ACKNOWLEDGED",
      })),
      more: read.more || read.motions.length > MOTION_ITEM_LIMIT,
    };
  }

  /** One meeting, by `meeting_get`. Its refusals reach the route as they are. */
  private async readMeeting(
    request: ActionRequest,
    meetingId: string,
  ): Promise<Meeting> {
    return meetingSchema.parse(
      await this.host.actions.invoke(request, "meeting_get", { id: meetingId }),
    );
  }

  /**
   * The last meeting of the same kind that was held before this one, with its
   * agenda, or null.
   *
   * The most recent fifty meetings come first, which is decades of an
   * association's meetings. Where none of them fits and older ones were left
   * out, the years before are read one at a time, back to the first year
   * with no meeting at all: an association holds an ordinary meeting every
   * year, so that year is before its meetings were recorded here.
   */
  private async previousMeeting(
    request: ActionRequest,
    meeting: Meeting,
  ): Promise<Meeting | null> {
    const fits = (candidate: MeetingSummary): boolean =>
      candidate.id !== meeting.id &&
      candidate.kind === meeting.kind &&
      candidate.concludedAt !== null &&
      candidate.heldOn < meeting.heldOn;

    // Furthest ahead first, so the first that fits is the most recent.
    const latest = await this.listMeetings(request, {});
    let previous = latest.meetings.find(fits);
    const oldest = latest.meetings.at(-1);
    if (previous === undefined && latest.more && oldest !== undefined) {
      // The oldest year listed may have been cut short, so it is read again.
      for (
        let year = Math.min(yearOf(oldest.heldOn), yearOf(meeting.heldOn));
        previous === undefined && year >= FIRST_LISTED_YEAR;
        year--
      ) {
        const { meetings } = await this.listMeetings(request, { year });
        if (meetings.length === 0) {
          break;
        }
        previous = meetings.find(fits);
      }
    }
    return previous === undefined
      ? null
      : this.readMeeting(request, previous.id);
  }

  /** The meetings `meeting_list` answers with, at most fifty. */
  private async listMeetings(
    request: ActionRequest,
    filter: { readonly year?: number },
  ): Promise<z.infer<typeof meetingListSchema>> {
    return meetingListSchema.parse(
      await this.host.actions.invoke(request, "meeting_list", {
        ...filter,
        limit: MEETINGS_PER_LIST,
      }),
    );
  }
}

/** The calendar year of an ISO date. */
function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * Refuses what would be sent when any text in it holds a personal identity
 * number: the recipient is not declared to receive one. Called on the board
 * member's own text before anything is read, and on the whole of what the
 * model is handed before it is sent, so a number in the meeting's record is
 * caught too. Each value is read on its own, as the prompt sets it apart.
 */
function refuseIdentityNumbers(sent: unknown): void {
  if (sentTexts(sent).some(holdsPersonalIdentityNumber)) {
    throw new MeetingSupportRefusal("personal-identity-number");
  }
}

/** Every string and number in a value, as the prompt writes them out. */
function sentTexts(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number") {
    return [String(value)];
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap(sentTexts);
}

/** The text the model wrote, its blocks joined. */
function textOf(response: ModelResponse): string {
  return response.message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/**
 * The agenda in the model's answer, or `no-draft`: an answer that was
 * declined or cut short need not follow the format it was asked for, and one
 * that does not fit `meeting_set_agenda` is not proposed.
 */
function agendaAnswer(
  response: ModelResponse,
): z.infer<typeof agendaAnswerSchema> {
  if (response.stop !== "end") {
    throw new MeetingSupportRefusal("no-draft");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textOf(response));
  } catch {
    throw new MeetingSupportRefusal("no-draft");
  }
  const checked = agendaAnswerSchema.safeParse(parsed);
  if (!checked.success) {
    throw new MeetingSupportRefusal("no-draft");
  }
  return checked.data;
}
