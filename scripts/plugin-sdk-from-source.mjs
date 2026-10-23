import { resolve } from "node:path";

import { build } from "esbuild";

import { languageOf, translate } from "../src/messages.ts";

/**
 * Bundles `@openbrf/plugin-sdk` from a checkout of `openbrf/openbrf` into one
 * ES module, for `check:package` to read through `OPENBRF_PLUGIN_SDK`.
 *
 *     node scripts/plugin-sdk-from-source.mjs <openbrf checkout> <out.mjs>
 *
 * A bridge until a release of the SDK reads every field the manifest uses.
 * zod is the SDK's one dependency and is resolved from this package's own
 * `node_modules`; NestJS, which it reads only for a decorator, stays external.
 */
const [checkout, out] = process.argv.slice(2);
if (checkout === undefined || out === undefined) {
  console.error(
    translate(
      languageOf(
        process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG,
      ),
      "cli.sdkFromSourceUsage",
    ),
  );
  process.exit(2);
}

await build({
  entryPoints: [resolve(checkout, "packages/plugin-sdk/src/index.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@nestjs/common", "@nestjs/common/*"],
  nodePaths: [resolve("node_modules")],
  logLevel: "warning",
});
