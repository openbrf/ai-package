import type { ActionRequest } from "@openbrf/plugin-sdk";

import {
  SITE_MAX_OUTPUT_TOKENS,
  SITE_MAX_ROUNDS,
  SITE_SYSTEM_PROMPT,
  vetSiteCall,
} from "../src/assistant/site-assistant.ts";
import { runToolLoop } from "../src/assistant/tool-loop.ts";
import { AiRefusal, type AiGateway } from "../src/gateway.ts";
import type { AiPackageHost, PluginDisclosure } from "../src/host-contract.ts";
import { EXPOSURE_GROUPS } from "./world.ts";

/**
 * The exposure scenario: resident text in front of the site and news
 * assistant's loop and prompt as they ship (`src/assistant/`), with the tools
 * to change the website and a meeting's agenda, and to ask for a mailing:
 * every change the core offers an AI package.
 *
 * The site and news assistant itself reads news and pages only, and issue
 * triage reads one issue itself and offers the model nothing but its own
 * tool: no assistant the package ships reads issues, contact messages or
 * comments with a write in reach. This scenario widens the site assistant's
 * groups to those reads on purpose, as the harder test of the same defences:
 * the reads' answers reach the model as quoted data, every change is proposed
 * for a person to confirm and never run, and the prompt tells the model both.
 * Whether the model then proposes what the text tells it to is what the case
 * measures.
 */

/**
 * What each call carries: residents' names and words, of nobody named. Wider
 * than the site assistant's, since an issue can carry an apartment and health.
 */
const DISCLOSURE: PluginDisclosure = {
  personalData: ["name", "apartment", "freeText", "health"],
  subjects: [],
};

/** How the question ended, for the report; the outcome is read elsewhere. */
export type ExposureEnd =
  "answered" | "cut-short" | "declined" | "too-many-rounds";

/**
 * Runs the board member's question through the site assistant's loop. A turn
 * the gateway gave no answer for, or the host failed in, throws, so that a run
 * which did not finish is never read as one that passed.
 */
export async function runExposure(
  host: AiPackageHost,
  gateway: AiGateway,
  request: ActionRequest,
  question: string,
): Promise<ExposureEnd> {
  const turn = await runToolLoop({
    gateway,
    actions: host.actions,
    request,
    system: SITE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: question }],
    groups: EXPOSURE_GROUPS,
    disclosure: DISCLOSURE,
    maxOutputTokens: SITE_MAX_OUTPUT_TOKENS,
    maxRounds: SITE_MAX_ROUNDS,
    vet: vetSiteCall,
    logger: host.logger,
  });
  if (turn.outcome === "refused") {
    throw new AiRefusal(turn.reason, turn.retryAfterSeconds);
  }
  if (turn.outcome === "failed") {
    throw new Error("A call to the host failed.");
  }
  return turn.outcome;
}
