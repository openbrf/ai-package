import type { PluginDisclosure } from "./host-contract.ts";

/**
 * What the package asks of a language model, and what it gets back, in terms
 * of its own rather than any one provider's.
 *
 * The assistants are written against this interface and never against a
 * provider's wire format, so the route to a model can change without them:
 * today the association's own key with Anthropic (`anthropic.ts`), and later
 * perhaps a route hosted by Apteo, which would hold the provider agreement on
 * the association's behalf and authenticate with the instance's licence
 * rather than a key. A route is chosen in `gateway.ts` and nowhere else.
 *
 * It covers what the assistants need and no more: a system prompt, a
 * conversation, tools the model may ask to call, and a limit on the answer.
 */

/** Text the model wrote, or that the conversation gives it. */
export interface ModelText {
  readonly type: "text";
  readonly text: string;
}

/** The model asking for a tool to be called. */
export interface ModelToolUse {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** The answer to a tool call, given back to the model. */
export interface ModelToolResult {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
}

export interface ModelUserMessage {
  readonly role: "user";
  readonly content: string | readonly (ModelText | ModelToolResult)[];
}

/**
 * The model's turn, as a response carried it.
 *
 * `content` is what the package reads. `replay` is the turn as the provider
 * sent it, opaque here and handed back unchanged when the conversation goes
 * on: a provider may put more in a turn than the package reads, such as the
 * model's reasoning, and expect it back as it was. A turn the package wrote
 * itself has none, and the provider builds one from `content`.
 */
export interface ModelAssistantMessage {
  readonly role: "assistant";
  readonly content: readonly (ModelText | ModelToolUse)[];
  readonly replay?: unknown;
}

export type ModelMessage = ModelUserMessage | ModelAssistantMessage;

/** A tool the model may ask to call, with a JSON Schema for its input. */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * Whether the provider holds the model's input to the schema exactly. Only
   * for a schema in which every object refuses unknown keys and lists every
   * key as required.
   */
  readonly strict?: boolean;
}

/** How much effort the model spends; a provider maps it to its own scale. */
export type ModelEffort = "low" | "medium" | "high";

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelTool[];
  /** The most the answer may run to, in tokens. */
  readonly maxOutputTokens: number;
  readonly effort?: ModelEffort;
  /**
   * Whether the provider may keep the request's start in its cache for the
   * next call. Worth it for a conversation that goes on over several calls, as
   * a tool loop does: each call sends the one before it again. The provider
   * keeps it for minutes, under the association's agreement with it.
   */
  readonly cache?: boolean;
  /** How long to wait for the answer. Two minutes when left out. */
  readonly timeoutMs?: number;
}

/**
 * Why the model stopped.
 *
 * - `end`: it finished its answer.
 * - `max-tokens`: it reached `maxOutputTokens`, so the answer is cut short.
 * - `tool-use`: it asks for the tools in its turn to be called.
 * - `refusal`: it declined, and the turn is to be read as no answer.
 */
export type ModelStop = "end" | "max-tokens" | "tool-use" | "refusal";

/** What a call cost, in tokens, as the provider counted them. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input read from the provider's cache. */
  readonly cacheReadTokens: number;
  /** Input written to the provider's cache. */
  readonly cacheWriteTokens: number;
}

export interface ModelResponse {
  readonly message: ModelAssistantMessage;
  readonly stop: ModelStop;
  readonly usage: ModelUsage;
  /** The model that answered, which a provider may have chosen. */
  readonly model: string;
}

/** One call to a provider, with what it carries about people. */
export interface ModelCall {
  readonly request: ModelRequest;
  /**
   * The personal data the request carries, and whom it is about, or null when
   * it carries none. The host records a disclosure per person before and after
   * the request is sent (ADR 0037).
   */
  readonly disclosure: PluginDisclosure | null;
}

/**
 * Why a provider gave no answer.
 *
 * - `unauthorised`: the provider refused the credential.
 * - `rate-limited`: the provider asks for fewer requests; try again later.
 * - `overloaded`: the provider is busy or failed on its side; try again later.
 * - `request-refused`: the provider found the request invalid, too large or
 *   not allowed for this account.
 * - `unreachable`: no answer came: the connection failed or the time ran out.
 * - `bad-response`: an answer came that the package cannot read.
 */
export type ProviderFailureReason =
  | "unauthorised"
  | "rate-limited"
  | "overloaded"
  | "request-refused"
  | "unreachable"
  | "bad-response";

/**
 * A provider's failure. The message never repeats the request or the answer,
 * which may name a resident, because the failure is logged.
 */
export class ProviderFailure extends Error {
  constructor(
    readonly reason: ProviderFailureReason,
    /** The provider's HTTP status, when it answered. */
    readonly status: number | null = null,
    /** When the provider says to try again, in seconds. */
    readonly retryAfterSeconds: number | null = null,
    /**
     * What the call used all the same, when the provider answered with usage
     * and the answer could not be read. It counts towards the monthly limit.
     */
    readonly usage: ModelUsage | null = null,
  ) {
    super(
      `The model provider gave no answer: ${reason}` +
        (status === null ? "." : ` (HTTP ${String(status)}).`),
    );
    this.name = "ProviderFailure";
  }
}

/** A route to a language model. */
export interface ModelProvider {
  /** The provider's name, for the board's screen and the log. */
  readonly name: string;
  /** The model it calls. */
  readonly model: string;
  complete(call: ModelCall): Promise<ModelResponse>;
}

/** Every token a call used, which is what the monthly limit counts. */
export function totalTokens(usage: ModelUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens
  );
}
