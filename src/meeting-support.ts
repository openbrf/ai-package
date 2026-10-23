import type { ActionRequest } from "@openbrf/plugin-sdk";
import { z } from "zod";

import type { AiGateway } from "./gateway.ts";
import type { AiPackageHost, PluginDisclosure } from "./host-contract.ts";
import {
  AGENDA_OUTPUT_SCHEMA,
  agendaPrompt,
  agendaSystem,
  minutesPrompt,
  minutesSystem,
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
 * notice's terms and never a person (ADR 0041 in openbrf/openbrf). The model
 * is offered no tools: it reads what the package hands it and answers with a
 * draft, so text in a meeting's record or in the notes can change a draft and
 * nothing else.
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
 * - `personal-identity-number`: the request or the notes hold a personal
 *   identity number, which is not sent to the model provider.
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

export interface MinutesDraft {
  readonly draft: string;
  /** False when the draft was cut short at the length the package allows. */
  readonly complete: boolean;
}

/** The longest notes the package takes, about twenty pages of text. */
export const MAX_NOTES_LENGTH = 50_000;

/** The longest request the board member adds to an agenda draft. */
export const MAX_INSTRUCTIONS_LENGTH = 2_000;

/** The most items an agenda holds, as `meeting_set_agenda` takes them. */
const MAX_AGENDA_ITEMS = 100;

/** The longest title an agenda item has, as `meeting_set_agenda` takes it. */
const MAX_TITLE_LENGTH = 300;

/**
 * Text a board member wrote: the agenda's titles, the notice's place, the
 * request and the notes. It can name anybody, and nobody in it is known by an
 * id, so the host records the disclosure once, with no person.
 */
const AGENDA_DISCLOSURE: PluginDisclosure = {
  personalData: ["freeText"],
  subjects: [],
};

/** Minutes notes name who spoke and who was elected, besides the free text. */
const MINUTES_DISCLOSURE: PluginDisclosure = {
  personalData: ["name", "freeText"],
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
});

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

export class MeetingSupport {
  constructor(
    private readonly host: AiPackageHost,
    private readonly gateway: AiGateway,
  ) {}

  /**
   * Drafts the meeting's agenda and proposes it for the board member to
   * confirm.
   *
   * Refused before any call to the model once the notice is out or the
   * meeting is held, since the agenda can then no longer be set. The draft
   * starts from the agenda of the last meeting of the same kind that was held,
   * where there is one.
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
    await this.requireActions(request, AGENDA_ACTIONS);

    const meeting = await this.readMeeting(request, meetingId);
    if (meeting.concludedAt !== null) {
      throw new MeetingSupportRefusal("meeting-already-held");
    }
    if (meeting.summoned) {
      throw new MeetingSupportRefusal("notice-already-issued");
    }
    const previous = await this.previousMeeting(request, meeting);

    const response = await this.gateway.complete(
      {
        system: agendaSystem(options.language),
        messages: [
          {
            role: "user",
            content: agendaPrompt(meeting, previous, options.instructions),
          },
        ],
        maxOutputTokens: 16_000,
        effort: "low",
        outputSchema: AGENDA_OUTPUT_SCHEMA,
      },
      AGENDA_DISCLOSURE,
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

    const response = await this.gateway.complete(
      {
        system: minutesSystem(options.language),
        messages: [
          { role: "user", content: minutesPrompt(meeting, options.notes) },
        ],
        maxOutputTokens: 32_000,
        effort: "medium",
        // A long meeting's minutes take a while to write, and the host waits
        // no longer than this on a recipient.
        timeoutMs: 300_000,
      },
      MINUTES_DISCLOSURE,
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
   */
  private async requireActions(
    request: ActionRequest,
    names: readonly string[],
  ): Promise<void> {
    const offered = new Set(
      (await this.host.actions.list(request)).map((action) => action.name),
    );
    if (names.some((name) => !offered.has(name))) {
      throw new MeetingSupportRefusal("host-unsupported");
    }
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
   * agenda, or null. Fifty meetings is the most `meeting_list` answers with,
   * and decades of an association's meetings.
   */
  private async previousMeeting(
    request: ActionRequest,
    meeting: Meeting,
  ): Promise<Meeting | null> {
    const { meetings } = meetingListSchema.parse(
      await this.host.actions.invoke(request, "meeting_list", { limit: 50 }),
    );
    // Furthest ahead first, so the first that fits is the most recent.
    const previous = meetings.find(
      (candidate) =>
        candidate.id !== meeting.id &&
        candidate.kind === meeting.kind &&
        candidate.concludedAt !== null &&
        candidate.heldOn < meeting.heldOn,
    );
    return previous === undefined
      ? null
      : this.readMeeting(request, previous.id);
  }
}

/**
 * Refuses a board member's text that holds a personal identity number, before
 * anything is read or sent: the recipient is not declared to receive one.
 */
function refuseIdentityNumbers(text: string | null): void {
  if (text !== null && holdsPersonalIdentityNumber(text)) {
    throw new MeetingSupportRefusal("personal-identity-number");
  }
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
