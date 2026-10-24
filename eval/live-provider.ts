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

/**
 * The most times `EVAL_REPEAT` may run each case. A full run is every case
 * in every scenario against every model, so each repeat is another full run's
 * spend on the key.
 */
export const MAX_EVAL_REPEAT = 10;

/** How many times each case runs: `EVAL_REPEAT`, 1 when it is not set. */
export function evalRepeat(given = process.env.EVAL_REPEAT): number {
  const text = given?.trim() ?? "";
  if (text === "") {
    return 1;
  }
  // Digits only: Number() would also take "1e1", " 0x5" or "10.0".
  const repeat = /^[0-9]{1,3}$/.test(text) ? Number(text) : Number.NaN;
  if (!(repeat >= 1 && repeat <= MAX_EVAL_REPEAT)) {
    throw new Error(
      `EVAL_REPEAT is ${JSON.stringify(given)}, not a whole number from 1 to ${String(MAX_EVAL_REPEAT)}.`,
    );
  }
  return repeat;
}

export function liveProvider(
  apiKey: string,
  model: AnthropicModel,
): ModelProvider {
  return anthropicProvider(recipients, apiKey, model);
}
