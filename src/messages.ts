import en from "../locales/en.json" with { type: "json" };
import sv from "../locales/sv.json" with { type: "json" };

/**
 * The package's own sentences, in the language a request or a terminal asks
 * for.
 *
 * They are the keys in `locales/`, the files the host merges under the
 * namespace `plugin-ai-package`. The host hands a plugin's server no
 * translator, so the package reads the copy bundled with it. Interpolation
 * and plurals follow i18next's rules, so the files mean the same to the host.
 */

export type Language = "sv" | "en";

const CATALOGUES: Record<Language, Catalogue> = { sv, en };

interface Catalogue {
  readonly [key: string]: string | Catalogue;
}

/** Dotted paths to the sentences, with a plural's suffix taken off. */
type Keys<Tree, Prefix extends string = ""> = {
  [Name in keyof Tree & string]: Tree[Name] extends string
    ? `${Prefix}${Name extends `${infer Base}_${"one" | "other"}` ? Base : Name}`
    : Keys<Tree[Name], `${Prefix}${Name}.`>;
}[keyof Tree & string];

export type MessageKey = Keys<typeof en>;

/**
 * The language a request or a terminal asks for.
 *
 * Read from the first tag only, as the host reads `Accept-Language`, and
 * Swedish, the product's default, for anything that is not English. A
 * terminal's `LANG` is written `en_US.UTF-8`, so `_` and `.` end the primary
 * subtag as `-` does.
 */
export function languageOf(tag: string | null | undefined): Language {
  const primary = tag
    ?.split(",")[0]
    ?.split(/[-_.;]/)[0]
    ?.trim()
    .toLowerCase();
  return primary === "en" ? "en" : "sv";
}

/**
 * One sentence, with `{{name}}` replaced by its value.
 *
 * A `count` picks the plural, `key_one` or `key_other`, by the language's own
 * rules. A key the file lacks comes back as the key, as the host renders one.
 */
export function translate(
  language: Language,
  key: MessageKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const { count } = values;
  const candidates =
    typeof count === "number"
      ? [`${key}_${new Intl.PluralRules(language).select(count)}`, key]
      : [key];
  for (const candidate of candidates) {
    const text = lookup(CATALOGUES[language], candidate);
    if (text !== undefined) {
      return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (placeholder, name) =>
        name in values ? String(values[name]) : placeholder,
      );
    }
  }
  return key;
}

function lookup(catalogue: Catalogue, key: string): string | undefined {
  let node: string | Catalogue | undefined = catalogue;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || !Object.hasOwn(node, segment)) {
      return undefined;
    }
    node = node[segment];
  }
  return typeof node === "string" ? node : undefined;
}
