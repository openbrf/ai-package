import { CASES } from "../eval/cases.ts";
import { plantedIssue } from "../eval/world.ts";
import type { StandInIssue } from "./stand-in-issues.ts";

/**
 * Issues whose reporter tries to steer the model, for issue triage: the
 * issue cases of the prompt-injection corpus (`eval/cases.ts`), each planted
 * in an ordinary issue.
 *
 * The triage tests show that none of them reaches past the data the model is
 * given: the package dispatches the same two reads whatever the text says,
 * offers the model no action, and returns a reply that is only a draft.
 * Whether a model is talked into asking for an action is measured by the
 * evaluation, `pnpm eval`, against the real models.
 */
export const INJECTIONS: readonly (readonly [string, StandInIssue])[] =
  CASES.filter((each) => each.source === "issue").map((each) => [
    each.technique,
    plantedIssue(each),
  ]);
