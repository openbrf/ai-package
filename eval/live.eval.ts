import { describe, expect, it } from "vitest";

import { AiRefusal } from "../src/gateway.ts";
import { CASES } from "./cases.ts";
import { evaluatedModels, liveProvider } from "./live-provider.ts";
import { type CaseRun, casesOf, runCase, SCENARIOS } from "./scenarios.ts";

/**
 * The release gate: every case of the corpus, in every scenario that reads
 * its source, against every model the board may choose, on the real API.
 *
 * Run with `pnpm eval` and `ANTHROPIC_API_KEY` set. `EVAL_MODELS` narrows the
 * models (comma-separated) and `EVAL_REPEAT` runs each case more than once,
 * since a model does not answer the same way every time. Any case that fails
 * once fails the gate, and so does a case the provider would not run: a gate
 * that did not run is not green.
 */

const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
const repeat = Number(process.env.EVAL_REPEAT ?? "1");

/** How often a call the provider turned away is tried again. */
const ATTEMPTS = 4;

describe("the prompt-injection evaluation", () => {
  it("has a key and a sensible repeat", () => {
    expect(
      apiKey,
      "Set ANTHROPIC_API_KEY: the gate runs against the real API.",
    ).not.toBe("");
    expect(Number.isSafeInteger(repeat) && repeat >= 1).toBe(true);
  });
});

describe.runIf(apiKey !== "").each(evaluatedModels())("%s", (model) => {
  const provider = liveProvider(apiKey, model);

  describe.each(SCENARIOS)("$name", (scenario) => {
    it.concurrent.each(casesOf(scenario, CASES).map((each) => [each.id, each]))(
      "%s",
      async (_id, planted) => {
        // A repeat that is not a number would run nothing and pass.
        expect(Number.isSafeInteger(repeat) && repeat >= 1).toBe(true);
        for (let run = 0; run < repeat; run++) {
          const result = await withRetries(() =>
            runCase(scenario, planted, provider),
          );
          expect(
            result.violations,
            `${planted.technique}, run ${String(run + 1)}: ended ${result.end}, ` +
              `asked for ${JSON.stringify(result.record.asked)}, ` +
              `proposed ${JSON.stringify(result.record.proposed)}`,
          ).toEqual([]);
        }
      },
    );
  });
});

/**
 * A run, again when the provider was busy or turned the call away, after the
 * wait it asked for or a growing one.
 */
async function withRetries(run: () => Promise<CaseRun>): Promise<CaseRun> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const busy =
        error instanceof AiRefusal &&
        (error.reason === "rate-limited" ||
          error.reason === "provider-failed") &&
        error.providerReason !== "unauthorised" &&
        error.providerReason !== "request-refused";
      if (!busy || attempt >= ATTEMPTS) {
        throw error;
      }
      const seconds = error.retryAfterSeconds ?? 10 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
    }
  }
}
