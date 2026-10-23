import {
  Body,
  Controller,
  type DynamicModule,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Module,
  Post,
  Req,
  SetMetadata,
} from "@nestjs/common";
import type {
  ActionRequest,
  PluginHost,
  PluginModuleFactory,
} from "@openbrf/plugin-sdk";

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
  type Language,
  languageOf,
  type MessageKey,
  translate,
} from "./messages.ts";

/**
 * The AI package's server entry point.
 *
 * It builds the gateway the assistants reach a model through and serves two
 * routes: `status`, which the board's screen reads (the licence finding, the
 * provider and model, whether a key is entered, and this month's use against
 * the limit), and `documents/ask`, the document assistant.
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
   * The refusal of a request neither route serves, or null. A host without
   * `actions.client` cannot say whether a connected app sent the request, so
   * it is answered as a host older than the package, before anything is read.
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
    controllers: [StatusController, DocumentAssistantController],
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
