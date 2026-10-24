import {
  BadRequestException,
  Body,
  Controller,
  type DynamicModule,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Module,
  Param,
  Post,
  Req,
  SetMetadata,
} from "@nestjs/common";
import type {
  ActionRequest,
  PluginHost,
  PluginModuleFactory,
} from "@openbrf/plugin-sdk";
import { z } from "zod";

import {
  conversationOf,
  runSiteTurn,
  type SiteTurnResponse,
} from "./assistant/site-assistant.ts";
import { isTurnId, sentAtOf } from "./assistant/turns.ts";
import {
  AssistantRefusal,
  type DocumentAnswer,
  DocumentAssistant,
  QUESTION_MAX_LENGTH,
  QUESTION_TOKEN_BUDGET,
} from "./document-assistant.ts";
import { AiGateway, AiRefusal, type AiStatus } from "./gateway.ts";
import type { AiPackageHost } from "./host-contract.ts";
import {
  type AgendaDraft,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_NOTES_LENGTH,
  MeetingSupport,
  MeetingSupportRefusal,
  type MinutesDraft,
} from "./meeting-support.ts";
import {
  type Language,
  languageOf,
  type MessageKey,
  translate,
} from "./messages.ts";

/**
 * The AI package's server entry point.
 *
 * It builds the gateway the assistants reach a model through and serves the
 * board's routes: `status`, which the board's screen reads (the licence
 * finding, the provider and model, whether a key is entered, and this month's
 * use against the limit), `documents/ask`, the document assistant, the site
 * and news assistant's turns, and meeting support's two drafts for a general
 * meeting, the agenda and the minutes.
 *
 * The controllers take no constructor arguments: they close over the host
 * object instead. The bundler that builds this file does not emit the
 * metadata NestJS would need to inject one.
 */

/**
 * The metadata key the host reads a route's required capabilities from, as
 * the host's `@RequireCapability` writes it. The SDK release this builds
 * against exports no decorator for it.
 */
const REQUIRED_CAPABILITIES = "openbrf:required-capabilities";

/** An id the platform handed out, bounded as `meeting_get` bounds it. */
const meetingIdSchema = z.string().min(1).max(64);

const languageSchema = z.enum(["sv", "en"]).optional();

const agendaDraftSchema = z.strictObject({
  /** What the board member asks for, such as the matters an extraordinary meeting is for. */
  instructions: z.string().trim().max(MAX_INSTRUCTIONS_LENGTH).optional(),
  /** The draft's language. The request's own when left out. */
  language: languageSchema,
});

const minutesDraftSchema = z.strictObject({
  notes: z.string().trim().min(1).max(MAX_NOTES_LENGTH),
  language: languageSchema,
});

/**
 * The status each refusal answers with, and its reason in the body, which a
 * view translates. A refusal by the host's registry or by the core's own
 * action, such as `meeting-not-found`, is rethrown as it came: the host
 * answers it with the status and body the registry would have.
 */
const STATUSES: Record<
  AiRefusal["reason"] | MeetingSupportRefusal["reason"],
  number
> = {
  "host-unsupported": 501,
  "entitlement-required": 403,
  "provider-not-configured": 503,
  "usage-limit-reached": 429,
  "rate-limited": 429,
  "provider-failed": 502,
  "notice-already-issued": 409,
  "meeting-already-held": 409,
  "no-draft": 422,
  "personal-identity-number": 400,
};

function answered(error: unknown): never {
  if (error instanceof AiRefusal) {
    throw new HttpException(
      {
        reason: error.reason,
        ...(error.retryAfterSeconds === null
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
        ...(error.providerReason === null
          ? {}
          : { providerReason: error.providerReason }),
      },
      STATUSES[error.reason],
    );
  }
  if (error instanceof MeetingSupportRefusal) {
    throw new HttpException({ reason: error.reason }, STATUSES[error.reason]);
  }
  // The host's refusals, which it answers itself, and faults.
  throw error;
}

/** A body the route's schema refuses, answered as the registry answers one. */
function parsed<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpException({ reason: "invalid-body" }, 400);
  }
  return result.data;
}

/** The draft's language: the body's, or the one the request asks for. */
function languageFor(
  request: ActionRequest,
  asked: Language | undefined,
): Language {
  if (asked !== undefined) {
    return asked;
  }
  const header = (request as { headers?: Record<string, unknown> }).headers?.[
    "accept-language"
  ];
  return languageOf(typeof header === "string" ? header : null);
}

export const createPlugin: PluginModuleFactory = (
  pluginHost: PluginHost,
): DynamicModule => {
  const host = pluginHost as unknown as AiPackageHost;
  const gateway = new AiGateway(host);
  const documents = new DocumentAssistant(host, gateway);

  /**
   * `association:read`, as the instance's plugin list is: the board answers
   * for how the instance is configured, and reads it without being able to
   * change it. The package declares no permission, so without this its
   * routes are held to `self:manage`, which every resident has.
   *
   * A connected app is refused even with a capability that would admit it:
   * the licence, the limit and the month's use are the board's to read.
   */
  @Controller("status")
  @SetMetadata(REQUIRED_CAPABILITIES, ["association:read"])
  class StatusController {
    @Get()
    async get(
      @Req() request: ActionRequest,
      @Headers("accept-language") acceptLanguage: string | undefined,
    ): Promise<AiStatus> {
      const refused = callerRefusal(request, languageOf(acceptLanguage));
      if (refused !== null) {
        throw refused;
      }
      return gateway.status();
    }
  }

  /**
   * `documents:manage`: the board, which keeps the archive. Each question is
   * paid for on the association's key and counts against its monthly limit,
   * so the assistant is the board's, as the record of processing says. What
   * it reads is still decided per person, by the document reads themselves.
   *
   * A connected app is refused: it has a model of its own, and reaches the
   * same reads through the MCP Connector without spending the association's
   * key.
   */
  @Controller("documents")
  @SetMetadata(REQUIRED_CAPABILITIES, ["documents:manage"])
  class DocumentAssistantController {
    @Post("ask")
    @HttpCode(200)
    async ask(
      @Req() request: ActionRequest,
      @Body() body: unknown,
      @Headers("accept-language") acceptLanguage: string | undefined,
    ): Promise<DocumentAnswer> {
      const language = languageOf(acceptLanguage);
      const refused = callerRefusal(request, language);
      if (refused !== null) {
        throw refused;
      }
      const question = questionOf(body);
      if (question === null) {
        throw refusal(language, 400, "question-invalid", "questionInvalid", {
          max: QUESTION_MAX_LENGTH,
        });
      }
      try {
        return await documents.ask(request, question);
      } catch (error) {
        throw refusalFor(language, error);
      }
    }
  }

  /**
   * One turn of the site and news assistant: the conversation so far, ending
   * with what the person last asked, answered with the model's reply and the
   * changes it proposed.
   *
   * `site:manage`, the board's own grant for the news and the pages, so the
   * route admits nobody the actions it reaches would refuse. A connected app
   * is refused: its token would put the turn's calls on `mcp` rather than
   * `ai`, and the assistant is the board's own screen. A host without
   * `actions.client` cannot say which a request is, and is older than
   * `actions.propose` as well, so the turn is answered `host-unsupported`.
   */
  @Controller("assistants/site")
  @SetMetadata(REQUIRED_CAPABILITIES, ["site:manage"])
  class SiteAssistantController {
    @Post("turns")
    @HttpCode(200)
    async turn(
      @Req() request: ActionRequest,
      @Body() body: unknown,
    ): Promise<SiteTurnResponse> {
      if (host.actions.client === undefined) {
        return { outcome: "host-unsupported" };
      }
      if (host.actions.client(request) !== null) {
        throw new ForbiddenException();
      }
      const {
        turnId,
        sentAt: sent,
        messages,
      } = typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
      const conversation = conversationOf(messages);
      const sentAt = sentAtOf(sent);
      if (!isTurnId(turnId) || sentAt === null || conversation === null) {
        throw new BadRequestException();
      }
      return runSiteTurn(host, gateway, request, {
        turnId,
        sentAt,
        messages: conversation,
      });
    }
  }

  const meetings = new MeetingSupport(host, gateway);

  /**
   * Meeting support, under `meetings:manage`: the capability the board's own
   * meetings screen requires, and the one `meeting_get` and
   * `meeting_set_agenda` require of the person the package acts for. A
   * connected app is refused: the drafts are for a board member at the
   * platform's own screens, where a proposed agenda is confirmed.
   */
  @Controller("meetings")
  @SetMetadata(REQUIRED_CAPABILITIES, ["meetings:manage"])
  class MeetingSupportController {
    /**
     * Drafts the agenda and proposes it. Nothing is written until the board
     * member confirms the pending change at the path the answer gives.
     */
    @Post(":meetingId/agenda-draft")
    @HttpCode(201)
    async draftAgenda(
      @Param("meetingId") meetingId: string,
      @Body() body: unknown,
      @Req() request: ActionRequest,
    ): Promise<AgendaDraft> {
      const refused = callerRefusal(request, languageFor(request, undefined));
      if (refused !== null) {
        throw refused;
      }
      const id = parsed(meetingIdSchema, meetingId);
      const input = parsed(agendaDraftSchema, body ?? {});
      try {
        return await meetings.draftAgenda(request, id, {
          instructions:
            input.instructions === undefined || input.instructions === ""
              ? null
              : input.instructions,
          language: languageFor(request, input.language),
        });
      } catch (error) {
        answered(error);
      }
    }

    /** Drafts the minutes from the notes in the body, and keeps nothing. */
    @Post(":meetingId/minutes-draft")
    @HttpCode(200)
    async draftMinutes(
      @Param("meetingId") meetingId: string,
      @Body() body: unknown,
      @Req() request: ActionRequest,
    ): Promise<MinutesDraft> {
      const refused = callerRefusal(request, languageFor(request, undefined));
      if (refused !== null) {
        throw refused;
      }
      const id = parsed(meetingIdSchema, meetingId);
      const input = parsed(minutesDraftSchema, body);
      try {
        return await meetings.draftMinutes(request, id, {
          notes: input.notes,
          language: languageFor(request, input.language),
        });
      } catch (error) {
        answered(error);
      }
    }
  }

  /**
   * The refusal of a request the status, document and meeting routes do not
   * serve, or null. A host without `actions.client` cannot say whether a
   * connected app sent the request, so it is answered as a host older than
   * the package, before anything is read.
   */
  function callerRefusal(
    request: ActionRequest,
    language: Language,
  ): HttpException | null {
    if (host.actions.client === undefined) {
      return refusal(language, 501, "host-unsupported", "hostUnsupported");
    }
    return host.actions.client(request) === null
      ? null
      : refusal(language, 403, "connected-app", "connectedApp");
  }

  @Module({})
  class AiPackageModule {}

  return {
    module: AiPackageModule,
    controllers: [
      StatusController,
      DocumentAssistantController,
      SiteAssistantController,
      MeetingSupportController,
    ],
  };
};

/**
 * The question in a request's body, or null when there is none to ask: the
 * body is `{ "question": "..." }` and nothing else, and the question has
 * something to read in it once blanks and invisible characters are set aside.
 */
export function questionOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const { question, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof question !== "string") {
    return null;
  }
  const trimmed = question.trim();
  if (
    trimmed.length > QUESTION_MAX_LENGTH ||
    trimmed.replace(/[\p{Cc}\p{Cf}\p{Z}]/gu, "") === ""
  ) {
    return null;
  }
  return trimmed;
}

/** The answer an error gives the board member, in their language. */
function refusalFor(language: Language, error: unknown): unknown {
  if (error instanceof AiRefusal) {
    const retry =
      error.retryAfterSeconds === null
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds };
    switch (error.reason) {
      case "host-unsupported":
        return refusal(language, 501, error.reason, "hostUnsupported");
      case "entitlement-required":
        return refusal(language, 403, error.reason, "entitlementRequired");
      case "provider-not-configured":
        return refusal(language, 503, error.reason, "providerNotConfigured");
      case "usage-limit-reached":
        return refusal(language, 429, error.reason, "usageLimitReached");
      case "rate-limited":
        return refusal(language, 429, error.reason, "rateLimited", {}, retry);
      case "provider-failed":
        return refusal(
          language,
          502,
          error.reason,
          "providerFailed",
          {},
          retry,
        );
    }
  }
  if (error instanceof AssistantRefusal) {
    switch (error.reason) {
      case "documents-unavailable":
        return refusal(language, 503, error.reason, "documentsUnavailable");
      case "too-little-left":
        return refusal(language, 429, error.reason, "tooLittleLeft", {
          budget: new Intl.NumberFormat(language).format(QUESTION_TOKEN_BUDGET),
        });
      case "model-declined":
        return refusal(language, 422, error.reason, "modelDeclined");
      case "no-answer":
        return refusal(language, 502, error.reason, "noAnswer");
    }
  }
  // Anything else is a fault, the host's to answer and log.
  return error;
}

/** The sentences under `refusals` in `locales/`. */
type RefusalKey<Key = MessageKey> = Key extends `refusals.${infer Name}`
  ? Name
  : never;

function refusal(
  language: Language,
  status: number,
  reason: string,
  key: RefusalKey,
  values: Readonly<Record<string, string | number>> = {},
  extra: Readonly<Record<string, unknown>> = {},
): HttpException {
  return new HttpException(
    {
      statusCode: status,
      reason,
      message: translate(language, `refusals.${key}`, values),
      ...extra,
    },
    status,
  );
}
