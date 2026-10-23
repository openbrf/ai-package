import { ANTHROPIC_MODELS, type AnthropicModel } from "./anthropic.ts";

/**
 * The board's settings, read from `host.settings.read()`.
 *
 * The host validates them against the manifest's `settingsSchema` on save, and
 * the defaults here are the manifest's. They are read again on every call, so
 * a change the board saves bites on the next one, and checked again here, so a
 * value the host kept from an older release of the package is read as the
 * default rather than trusted.
 */

export interface AiSettings {
  /** The association's own API key, or null when none is entered. */
  readonly apiKey: string | null;
  readonly model: AnthropicModel;
  readonly monthlyTokenLimit: number;
  readonly requestsPerMinute: number;
}

export const SETTINGS_DEFAULTS = {
  model: "claude-opus-5-5",
  monthlyTokenLimit: 2_000_000,
  requestsPerMinute: 10,
} as const satisfies Omit<AiSettings, "apiKey">;

/** The longest key the manifest's `apiKey` setting takes. */
export const API_KEY_MAX_LENGTH = 512;

const LIMITS = {
  monthlyTokenLimit: { min: 0, max: 1_000_000_000 },
  requestsPerMinute: { min: 1, max: 120 },
} as const;

export function aiSettings(
  values: Readonly<Record<string, unknown>>,
): AiSettings {
  const { apiKey, model } = values;
  // A key is never padded; blanks around one are a paste, and a key of blanks
  // alone is no key. One longer than the manifest allows was kept from an
  // older release, and is no key either.
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  return {
    apiKey: key !== "" && key.length <= API_KEY_MAX_LENGTH ? key : null,
    model: ANTHROPIC_MODELS.includes(model as AnthropicModel)
      ? (model as AnthropicModel)
      : SETTINGS_DEFAULTS.model,
    monthlyTokenLimit: bounded(values, "monthlyTokenLimit"),
    requestsPerMinute: bounded(values, "requestsPerMinute"),
  };
}

function bounded(
  values: Readonly<Record<string, unknown>>,
  key: keyof typeof LIMITS,
): number {
  const value = values[key];
  const { min, max } = LIMITS[key];
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : SETTINGS_DEFAULTS[key];
}
