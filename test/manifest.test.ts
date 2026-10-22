import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MODELS,
  MODEL_PROVIDER_RECIPIENT,
} from "../src/anthropic.ts";
import { aiSettings, SETTINGS_DEFAULTS } from "../src/settings.ts";

/**
 * What the manifest declares, held to what the code reads: the settings and
 * their defaults, the recipient the adapter reaches, and a translation for
 * every label the settings form shows.
 */

interface Field {
  key: string;
  type: string;
  labelKey: string;
  hintKey?: string;
  default?: unknown;
  min?: number;
  max?: number;
  options?: { value: string; labelKey: string }[];
}

const manifest = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    openbrf: {
      personalData: string[];
      settingsSchema: { fields: Field[] };
      recipients: { id: string; origin: string; personalData: string[] }[];
      licence: { entitlement: string };
      ai: boolean;
    };
  }
).openbrf;

const locales = {
  sv: JSON.parse(
    readFileSync(new URL("../locales/sv.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>,
  en: JSON.parse(
    readFileSync(new URL("../locales/en.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>,
};

const field = (key: string): Field => {
  const found = manifest.settingsSchema.fields.find((each) => each.key === key);
  if (found === undefined) {
    throw new Error(`No setting ${key}.`);
  }
  return found;
};

function keys(tree: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([name, value]) =>
    typeof value === "string"
      ? [`${prefix}${name}`]
      : keys(value as Record<string, unknown>, `${prefix}${name}.`),
  );
}

describe("the manifest", () => {
  it("keeps the key in a secret setting, with no default", () => {
    expect(field("apiKey")).toMatchObject({ type: "secret" });
    expect(field("apiKey")).not.toHaveProperty("default");
  });

  it("offers the models the adapter knows, with the code's default", () => {
    expect(field("model").options?.map((option) => option.value)).toEqual([
      ...ANTHROPIC_MODELS,
    ]);
    expect(field("model").default).toBe(SETTINGS_DEFAULTS.model);
  });

  it("declares the limits with the code's defaults and bounds", () => {
    for (const key of ["monthlyTokenLimit", "requestsPerMinute"] as const) {
      const declared = field(key);
      expect(declared.default).toBe(SETTINGS_DEFAULTS[key]);
      // A value at each declared bound is read as given, not as the default.
      expect(aiSettings({ [key]: declared.min })[key]).toBe(declared.min);
      expect(aiSettings({ [key]: declared.max })[key]).toBe(declared.max);
      expect(aiSettings({ [key]: (declared.max ?? 0) + 1 })[key]).toBe(
        SETTINGS_DEFAULTS[key],
      );
    }
  });

  it("declares the recipient the adapter reaches, receiving what the package handles", () => {
    expect(manifest.recipients).toEqual([
      expect.objectContaining({
        id: MODEL_PROVIDER_RECIPIENT,
        origin: "https://api.anthropic.com",
        personalData: manifest.personalData,
      }),
    ]);
  });

  it("reads the ai-package entitlement and declares itself an AI package", () => {
    expect(manifest.licence.entitlement).toBe("ai-package");
    expect(manifest.ai).toBe(true);
  });

  it("has a Swedish and an English text for every label and hint", () => {
    const wanted = manifest.settingsSchema.fields.flatMap((each) => [
      each.labelKey,
      ...(each.hintKey === undefined ? [] : [each.hintKey]),
      ...(each.options ?? []).map((option) => option.labelKey),
    ]);
    for (const language of ["sv", "en"] as const) {
      expect(keys(locales[language])).toEqual(expect.arrayContaining(wanted));
    }
  });

  it("has the same keys in both languages", () => {
    expect(keys(locales.sv).sort()).toEqual(keys(locales.en).sort());
  });
});
