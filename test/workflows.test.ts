import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MAX_EVAL_REPEAT } from "../eval/live-provider.ts";

/**
 * What the workflows promise about the model provider key: only a job in an
 * environment reads it, so the environment's deployment rules decide which
 * refs may, and the evaluation starts no run of its own on a push.
 */

const DIRECTORY = new URL("../.github/workflows/", import.meta.url);

const WORKFLOWS = readdirSync(DIRECTORY)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name): [string, string] => [
    name,
    readFileSync(new URL(name, DIRECTORY), "utf8"),
  ]);

/** The lines of each job under `jobs:`, by the job's id. */
function jobsOf(workflow: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let inJobs = false;
  let current: string[] | null = null;
  for (const line of workflow.split("\n")) {
    if (/^\S/.test(line)) {
      inJobs = line.startsWith("jobs:");
      current = null;
      continue;
    }
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (inJobs && id !== null) {
      current = [];
      jobs.set(id[1] as string, current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  return jobs;
}

/** The top-level `on:` block. */
function triggersOf(workflow: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf("on:");
  const end = lines.findIndex(
    (line, index) => index > start && /^\S/.test(line),
  );
  return lines.slice(start + 1, end).join("\n");
}

describe("the workflows", () => {
  it("are read", () => {
    expect(WORKFLOWS.map(([name]) => name)).toContain("injection-eval.yml");
  });

  it.each(WORKFLOWS)(
    "%s reads ANTHROPIC_API_KEY only in a job with an environment",
    (_name, workflow) => {
      for (const [id, lines] of jobsOf(workflow)) {
        if (lines.some((line) => line.includes("secrets.ANTHROPIC_API_KEY"))) {
          expect(
            lines.some((line) => /^ {4}environment:\s*\S/.test(line)),
            id,
          ).toBe(true);
        }
      }
    },
  );

  it("does not start the evaluation on a push, a tag or a pull request", () => {
    const workflow = new Map(WORKFLOWS).get("injection-eval.yml") as string;
    const triggers = triggersOf(workflow);

    expect(triggers).not.toMatch(/^ {2}(push|pull_request\w*):/m);
    expect(triggers).toMatch(/^ {2}workflow_dispatch:/m);
    expect(triggers).toMatch(/^ {2}workflow_call:/m);
  });

  it("offers a repeat no higher than the evaluation takes", () => {
    const workflow = new Map(WORKFLOWS).get("injection-eval.yml") as string;
    const options = /^ {8}options: \[(.*)\]$/m.exec(triggersOf(workflow));

    expect(options?.[1]?.split(", ").map((each) => JSON.parse(each))).toEqual(
      Array.from({ length: MAX_EVAL_REPEAT }, (_each, index) =>
        String(index + 1),
      ),
    );
    expect(triggersOf(workflow)).toMatch(/^ {8}type: choice$/m);
  });
});
