import {
  Body,
  Controller,
  type DynamicModule,
  ForbiddenException,
  Get,
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
import { type Language, languageOf } from "./messages.ts";

/**
 * The AI package's server entry point.
 *
 * It builds the gateway the assistants reach a model through and serves the
 * board's routes: `status`, which the board's screen reads (the licence
 * finding, the provider and model, whether a key is entered, and this month's
 * use against the limit), and meeting support's two drafts for a general
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
  "provider-not-configured": 409,
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
    async get(@Req() request: ActionRequest): Promise<AiStatus> {
      refuseConnectedApp(request);
      return gateway.status();
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
      refuseConnectedApp(request);
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
      refuseConnectedApp(request);
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
   * A host without `actions.client` cannot say who sent the request. The
   * route is behind its session guard all the same.
   */
  function refuseConnectedApp(request: ActionRequest): void {
    if ((host.actions.client?.(request) ?? null) !== null) {
      throw new ForbiddenException();
    }
  }

  @Module({})
  class AiPackageModule {}

  return {
    module: AiPackageModule,
    controllers: [StatusController, MeetingSupportController],
  };
};
