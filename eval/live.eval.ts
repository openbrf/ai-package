import { describe, expect, it } from "vitest";

import { CASES } from "./cases.ts";
import { evalRepeat, evaluatedModels, liveProvider } from "./live-provider.ts";
import { casesOf, retrying, runCase, SCENARIOS } from "./scenarios.ts";

/**
 * The release gate: every case of the corpus, in every scenario that reads
 * its source, against every model the board may choose, on the real API.
 *
 * Run with `pnpm eval` and `ANTHROPIC_API_KEY` set. `EVAL_MODELS` narrows the
 * models (comma-separated) and `EVAL_REPEAT` runs each case more than once,
 * since a model does not answer the same way every time, at most ten times:
 * a value outside that fails the run before any call. Any case that fails
 * once fails the gate, and so does a case the provider would not run, or one
 * in which the planted text never reached the model: a gate that did not run
 * is not green. A call the provider was busy for is tried again within the
 * same run, so what the model did before it still counts.
 */

const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
// Read before anything runs: a repeat out of bounds fails the whole run.
const repeat = evalRepeat();

describe("the prompt-injection evaluation", () => {
  it("has a key", () => {
    expect(
      apiKey,
      "Set ANTHROPIC_API_KEY: the gate runs against the real API.",
    ).not.toBe("");
  });
});

describe.runIf(apiKey !== "").each(evaluatedModels())("%s", (model) => {
  const provider = retrying(liveProvider(apiKey, model));

  describe.each(SCENARIOS)("$name", (scenario) => {
    it.concurrent.each(casesOf(scenario, CASES).map((each) => [each.id, each]))(
      "%s",
      async (_id, planted) => {
        for (let run = 0; run < repeat; run++) {
          const result = await runCase(scenario, planted, provider);
          expect(
            result.violations,
            `${planted.technique}, run ${String(run + 1)}: ended ${result.end}, ` +
              `asked for ${JSON.stringify(result.record.asked)}, ` +
              `proposed ${JSON.stringify(result.record.proposed)}, ` +
              `never read ${JSON.stringify(result.record.unseen)}, ` +
              `carried the canary into ${JSON.stringify(result.record.carried)}`,
          ).toEqual([]);
        }
      },
    );
  });
});
