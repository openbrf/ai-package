import { readFileSync } from "node:fs";

import {
  ANTHROPIC_MODELS,
  type AnthropicModel,
  anthropicProvider,
  MODEL_PROVIDER_RECIPIENT,
} from "../src/anthropic.ts";
import type {
  PluginRecipientRequest,
  PluginRecipientResponse,
  PluginRecipients,
} from "../src/host-contract.ts";
import type { ModelProvider } from "../src/provider.ts";

/**
 * The package's own Anthropic adapter, reaching the real API: the way out an
 * instance gives the package, with the origin the manifest declares, done
 * here with `fetch`. So the live evaluation sends exactly the requests the
 * package sends, on the key in `ANTHROPIC_API_KEY`.
 */

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { openbrf: { recipients: { id: string; origin: string }[] } };

const ORIGIN = manifest.openbrf.recipients.find(
  (recipient) => recipient.id === MODEL_PROVIDER_RECIPIENT,
)?.origin;

class Unreachable extends Error {
  readonly code = "unreachable";

  constructor() {
    super("The model provider could not be reached.");
    this.name = "PluginRecipientError";
  }
}

/** `host.recipients`, as an instance with no outbound rules would answer. */
const recipients: PluginRecipients = {
  async fetch(
    id: string,
    path: string,
    init: PluginRecipientRequest = {},
  ): Promise<PluginRecipientResponse> {
    if (id !== MODEL_PROVIDER_RECIPIENT || ORIGIN === undefined) {
      throw new Error(`No recipient ${id} in the manifest.`);
    }
    let response: Response;
    try {
      response = await fetch(new URL(path, ORIGIN), {
        method: init.method ?? "GET",
        headers: init.headers,
        // The adapter sends text; bytes are copied to a buffer fetch takes.
        body:
          init.body === undefined || typeof init.body === "string"
            ? init.body
            : new Uint8Array(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
      });
    } catch {
      throw new Unreachable();
    }
    const body = new Uint8Array(await response.arrayBuffer());
    const text = () => new TextDecoder().decode(body);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
      text,
      json: () => JSON.parse(text()) as unknown,
    };
  },
};

/** The models to evaluate: `EVAL_MODELS`, or every model the board may pick. */
export function evaluatedModels(
  listed = process.env.EVAL_MODELS,
): AnthropicModel[] {
  if (listed === undefined || listed.trim() === "") {
    return [...ANTHROPIC_MODELS];
  }
  const models = listed.split(",").map((model) => model.trim());
  for (const model of models) {
    if (!(ANTHROPIC_MODELS as readonly string[]).includes(model)) {
      throw new Error(
        `EVAL_MODELS names ${model}, which is not one of ${ANTHROPIC_MODELS.join(", ")}.`,
      );
    }
  }
  return models as AnthropicModel[];
}

export function liveProvider(
  apiKey: string,
  model: AnthropicModel,
): ModelProvider {
  return anthropicProvider(recipients, apiKey, model);
}
