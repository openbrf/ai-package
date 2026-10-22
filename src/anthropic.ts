import type Anthropic from "@anthropic-ai/sdk";

import { type PluginRecipients, recipientErrorCode } from "./host-contract.ts";
import {
  type ModelAssistantMessage,
  type ModelCall,
  type ModelMessage,
  type ModelProvider,
  type ModelResponse,
  type ModelStop,
  type ModelUsage,
  ProviderFailure,
} from "./provider.ts";

/**
 * The route to a model on the association's own Anthropic API key.
 *
 * Every request goes through `host.recipients.fetch` to the recipient the
 * manifest declares, `model-provider` at `https://api.anthropic.com`: the way
 * out the board consented to, which applies the instance's outbound address
 * rules and records each disclosure of personal data before and after the
 * request is sent (ADR 0037). That is why the Messages API is spoken here
 * over plain HTTP rather than through Anthropic's SDK, which would open a
 * connection of its own. The SDK's types still describe the wire format.
 *
 * The association is the controller and Anthropic its processor, under the
 * agreement the association accepted with its own API account.
 */

/** The recipient's id in the manifest. */
export const MODEL_PROVIDER_RECIPIENT = "model-provider";

/** The Messages API version every request is written for. */
export const ANTHROPIC_VERSION = "2026-10-21";

/** The models the board may choose, as the settings form offers them. */
export const ANTHROPIC_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];

/**
 * The models with a server-side fallback: a request the model declines on
 * policy grounds is run again on the model Anthropic recommends for that kind
 * of decline, within the same call and on the same key. Claude Haiku 5.5 has
 * none.
 */
const WITH_FALLBACK: ReadonlySet<AnthropicModel> = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
]);

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const DEFAULT_TIMEOUT_MS = 120_000;

/** The longest the host waits on a recipient. */
const MAX_TIMEOUT_MS = 300_000;

type RequestBody = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ResponseMessage = Anthropic.Beta.Messages.BetaMessage;

export function anthropicProvider(
  recipients: PluginRecipients,
  apiKey: string,
  model: AnthropicModel,
): ModelProvider {
  return {
    name: "Anthropic",
    model,
    complete: (call) => complete(recipients, apiKey, model, call),
  };
}

async function complete(
  recipients: PluginRecipients,
  apiKey: string,
  model: AnthropicModel,
  call: ModelCall,
): Promise<ModelResponse> {
  const fallback = WITH_FALLBACK.has(model);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (fallback) {
    headers["anthropic-beta"] = FALLBACK_BETA;
  }

  let response;
  try {
    response = await recipients.fetch(
      MODEL_PROVIDER_RECIPIENT,
      "/v1/messages",
      {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody(model, call, fallback)),
        ...(call.disclosure === null ? {} : { disclosure: call.disclosure }),
        timeoutMs: Math.min(
          call.request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          MAX_TIMEOUT_MS,
        ),
      },
    );
  } catch (cause) {
    const code = recipientErrorCode(cause);
    if (code === "unreachable") {
      throw new ProviderFailure("unreachable");
    }
    // Any other refusal by the host is the package's own defect or the
    // instance's configuration, and is the host's to explain.
    throw cause;
  }

  if (response.status !== 200) {
    throw failureFor(response.status, response.headers);
  }

  let message: ResponseMessage;
  try {
    message = response.json() as ResponseMessage;
  } catch {
    throw new ProviderFailure("bad-response", response.status);
  }
  const usage = usageOf(message);
  if (usage === null) {
    throw new ProviderFailure("bad-response", response.status);
  }
  const stop = stopOf(message.stop_reason);
  if (stop === null || !Array.isArray(message.content)) {
    throw new ProviderFailure("bad-response", response.status, null, usage);
  }
  return {
    message: assistantMessage(message.content),
    stop,
    usage,
    model: typeof message.model === "string" ? message.model : model,
  };
}

export function requestBody(
  model: AnthropicModel,
  call: ModelCall,
  fallback: boolean,
): RequestBody {
  const { request } = call;
  return {
    model,
    max_tokens: request.maxOutputTokens,
    system: request.system,
    messages: request.messages.map(messageParam),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: {
              ...tool.inputSchema,
              type: "object" as const,
            },
          })),
        }),
    ...(request.effort === undefined
      ? {}
      : { output_config: { effort: request.effort } }),
    ...(fallback ? { fallbacks: "default" as const } : {}),
  };
}

function messageParam(message: ModelMessage): MessageParam {
  if (message.role === "assistant") {
    // A turn the provider sent is handed back exactly as it came, with
    // whatever the package does not read: the model's reasoning, and the
    // record of a fallback, which the API expects to see again.
    if (Array.isArray(message.replay)) {
      return {
        role: "assistant",
        content:
          message.replay as Anthropic.Beta.Messages.BetaContentBlockParam[],
      };
    }
    return {
      role: "assistant",
      content: message.content.map((block) =>
        block.type === "text"
          ? { type: "text", text: block.text }
          : {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            },
      ),
    };
  }
  if (typeof message.content === "string") {
    return { role: "user", content: message.content };
  }
  return {
    role: "user",
    content: message.content.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : {
            type: "tool_result",
            tool_use_id: block.toolUseId,
            content: block.content,
            ...(block.isError === true ? { is_error: true } : {}),
          },
    ),
  };
}

function assistantMessage(
  content: ResponseMessage["content"],
): ModelAssistantMessage {
  const read: ModelAssistantMessage["content"][number][] = [];
  for (const block of content) {
    if (block.type === "text") {
      read.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      read.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }
  return { role: "assistant", content: read, replay: content };
}

function stopOf(reason: unknown): ModelStop | null {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max-tokens";
    case "tool_use":
      return "tool-use";
    case "refusal":
      return "refusal";
    default:
      // `pause_turn` and `compaction` belong to features no request here
      // asks for, so an answer stopping on one is not one this reads.
      return null;
  }
}

function usageOf(message: unknown): ModelUsage | null {
  const usage = (message as { usage?: unknown } | null)?.usage;
  if (typeof usage !== "object" || usage === null) {
    return null;
  }
  const fields = usage as Record<string, unknown>;
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const inputTokens = count(fields.input_tokens);
  const outputTokens = count(fields.output_tokens);
  if (inputTokens === null || outputTokens === null) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: count(fields.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: count(fields.cache_creation_input_tokens) ?? 0,
  };
}

/**
 * The failure an HTTP status stands for, by Anthropic's error table.
 *
 * The body is not read: it is the provider's prose, and the reason and the
 * status are what the package acts on.
 */
function failureFor(
  status: number,
  headers: Readonly<Record<string, string>>,
): ProviderFailure {
  const retryAfter = retryAfterSeconds(headers["retry-after"]);
  if (status === 401 || status === 403) {
    return new ProviderFailure("unauthorised", status);
  }
  if (status === 429) {
    return new ProviderFailure("rate-limited", status, retryAfter);
  }
  if (status >= 500) {
    return new ProviderFailure("overloaded", status, retryAfter);
  }
  return new ProviderFailure("request-refused", status);
}

function retryAfterSeconds(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,6}$/.test(value.trim())) {
    return null;
  }
  return Number(value.trim());
}
