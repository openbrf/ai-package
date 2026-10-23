import type { ActionRequest } from "@openbrf/plugin-sdk";

import { AiRefusal, type AiRefusalReason } from "../gateway.ts";
import {
  type ActionWithSchemas,
  type AiPackageActions,
  actionRefusalOf,
  type PluginDisclosure,
} from "../host-contract.ts";
import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelTool,
  ModelToolResult,
  ModelToolUse,
} from "../provider.ts";

/**
 * One turn of an assistant: the model's answer to what the person last said,
 * with the actions it called on the way.
 *
 * The tools are the actions the host offers this plugin on the `ai` surface,
 * in the groups the assistant names, as `host.actions.list` hands them over:
 * filtered by the person's capabilities and the arming, so the model is told
 * of nothing the person could not do themselves. A read runs through
 * `invoke`. Every other call is proposed through `host.actions.propose` and
 * never invoked, so nothing the model chooses is written until the person
 * confirms it on the platform's own screen (ADR 0039). The host refuses a
 * write on `ai` all the same; the loop does not lean on that.
 *
 * A call the model repeats with the same input in the same turn is proposed
 * once, and the model is answered with the first receipt.
 */

/** What the model is told a held change is, and where the person confirms it. */
export interface Proposal {
  readonly id: string;
  /** The action's name, which the model chose. */
  readonly action: string;
  /** The action's title, in the language of the request. */
  readonly title: string;
  /** The pending change on the platform's own screen, relative to the origin. */
  readonly path: string;
  readonly expiresAt: string;
}

/**
 * How a turn ended.
 *
 * - `answered`: the model finished its answer.
 * - `cut-short`: the answer reached its length limit.
 * - `too-many-rounds`: the model kept calling tools past the turn's limit.
 * - `declined`: the model declined to answer.
 * - `refused`: the gateway made no call, or the call gave no answer.
 * - `failed`: a call to the host failed in a way that is no answer at all, or
 *   the turn may not go on (`proceed`).
 *
 * Whatever the end, `proposals` holds every change the turn proposed, which
 * stays proposed: the person decides each one on the pending changes screen.
 */
export type TurnOutcome =
  | {
      readonly outcome: "answered" | "cut-short";
      readonly answer: string;
      readonly proposals: readonly Proposal[];
    }
  | {
      readonly outcome: "too-many-rounds" | "declined";
      readonly proposals: readonly Proposal[];
    }
  | {
      readonly outcome: "refused";
      readonly reason: AiRefusalReason;
      readonly retryAfterSeconds: number | null;
      readonly proposals: readonly Proposal[];
    }
  | { readonly outcome: "failed"; readonly proposals: readonly Proposal[] };

/** The one call into the gateway the loop makes. */
export interface ModelGateway {
  complete(
    request: ModelRequest,
    disclosure: PluginDisclosure | null,
  ): Promise<ModelResponse>;
}

export interface ToolLoopOptions {
  readonly gateway: ModelGateway;
  readonly actions: AiPackageActions;
  /** The request the plugin's route is serving, which every call acts for. */
  readonly request: ActionRequest;
  readonly system: string;
  /** The conversation so far, ending with what the person last said. */
  readonly messages: readonly ModelMessage[];
  /** The action groups the assistant may use. */
  readonly groups: readonly string[];
  /** What each call to the model carries about people (see `AiGateway`). */
  readonly disclosure: PluginDisclosure | null;
  readonly maxOutputTokens: number;
  /** The most calls to the model one turn makes. */
  readonly maxRounds: number;
  /**
   * The assistant's own rule for a call, before it is proposed: a reason the
   * model is answered with instead, or null to let it through.
   */
  readonly vet?: (action: ActionWithSchemas, input: unknown) => string | null;
  /**
   * Asked before each call to the model and each new proposal: false ends the
   * turn there as `failed`, with nothing more called or proposed.
   */
  readonly proceed?: () => Promise<boolean>;
  /** Told of each proposal as it is made, before the model hears of it. */
  readonly onProposal?: (proposal: Proposal) => Promise<void>;
  readonly logger: { warn(message: string): void };
}

export async function runToolLoop(
  options: ToolLoopOptions,
): Promise<TurnOutcome> {
  const { actions, request } = options;
  const proposals: Proposal[] = [];
  const proposedByCall = new Map<string, Proposal>();

  const offered = (await actions.list(request, { surface: "ai" })).filter(
    (action) =>
      options.groups.includes(action.group) && action.inputSchema !== undefined,
  );
  const byName = new Map(offered.map((action) => [action.name, action]));
  const tools: ModelTool[] = offered.map(toolOf);

  const messages: ModelMessage[] = [...options.messages];
  for (let round = 0; round < options.maxRounds; round++) {
    if (!(await proceed())) {
      return { outcome: "failed", proposals };
    }
    let response: ModelResponse;
    try {
      response = await options.gateway.complete(
        {
          system: options.system,
          // A copy: the loop goes on adding to its own.
          messages: [...messages],
          tools,
          maxOutputTokens: options.maxOutputTokens,
        },
        options.disclosure,
      );
    } catch (error) {
      if (error instanceof AiRefusal) {
        return {
          outcome: "refused",
          reason: error.reason,
          retryAfterSeconds: error.retryAfterSeconds,
          proposals,
        };
      }
      throw error;
    }

    const answer = textOf(response);
    if (response.stop === "refusal") {
      return { outcome: "declined", proposals };
    }
    if (response.stop === "max-tokens") {
      return { outcome: "cut-short", answer, proposals };
    }
    const uses = response.message.content.filter(
      (block): block is ModelToolUse => block.type === "tool_use",
    );
    if (response.stop === "end" || uses.length === 0) {
      return { outcome: "answered", answer, proposals };
    }

    messages.push(response.message);
    const results: ModelToolResult[] = [];
    for (const use of uses) {
      const result = await call(use);
      if (result === null) {
        return { outcome: "failed", proposals };
      }
      results.push(result);
    }
    messages.push({ role: "user", content: results });
  }

  return { outcome: "too-many-rounds", proposals };

  async function proceed(): Promise<boolean> {
    return options.proceed === undefined || (await options.proceed());
  }

  /**
   * One tool call, answered for the model; null when the host failed in a way
   * that is no answer, or the turn may not go on, which ends the turn.
   */
  async function call(use: ModelToolUse): Promise<ModelToolResult | null> {
    const action = byName.get(use.name);
    if (action === undefined) {
      return refused(use, { reason: "unknown-action", retry: "never" });
    }
    try {
      if (action.effect === "read") {
        const output: unknown = await actions.invoke(
          request,
          action.name,
          use.input,
        );
        return {
          type: "tool_result",
          toolUseId: use.id,
          content: json(output),
        };
      }

      const vetoed = options.vet?.(action, use.input) ?? null;
      if (vetoed !== null) {
        return refused(use, { reason: vetoed, retry: "after-edit" });
      }
      const key = `${action.name}\n${canonicalJson(use.input)}`;
      let proposal = proposedByCall.get(key);
      if (proposal === undefined) {
        if (actions.propose === undefined) {
          // Checked by the assistant before the turn; a host that lost the
          // member since cannot hold the change, so nothing is called.
          return refused(use, { reason: "host-unsupported", retry: "never" });
        }
        if (!(await proceed())) {
          return null;
        }
        const receipt = await actions.propose(request, action.name, use.input);
        proposal = {
          id: receipt.id,
          action: action.name,
          title: action.title,
          path: receipt.path,
          expiresAt: new Date(receipt.expiresAt).toISOString(),
        };
        proposedByCall.set(key, proposal);
        proposals.push(proposal);
        await options.onProposal?.(proposal);
      }
      return {
        type: "tool_result",
        toolUseId: use.id,
        content: json({
          heldForConfirmation: true,
          pendingChange: proposal.id,
          expiresAt: proposal.expiresAt,
        }),
      };
    } catch (error) {
      const refusal = actionRefusalOf(error);
      if (refusal !== null) {
        return refused(use, refusal);
      }
      // The name only: the error may carry what was sent.
      options.logger.warn(
        `The assistant's call to ${action.name} failed ` +
          `(${error instanceof Error ? error.name : "unknown error"}).`,
      );
      return null;
    }
  }
}

/** A tool as the model is told of it. */
function toolOf(action: ActionWithSchemas): ModelTool {
  // The dialect marker is for a validator, and a provider may refuse a key it
  // does not take at the top of a tool's schema.
  const { $schema: _dialect, ...inputSchema } = action.inputSchema ?? {};
  return {
    name: action.name,
    description: action.description,
    inputSchema,
  };
}

function refused(
  use: ModelToolUse,
  refusal: {
    readonly reason: string;
    readonly retry: string;
    readonly details?: Readonly<Record<string, readonly unknown[]>>;
  },
): ModelToolResult {
  return {
    type: "tool_result",
    toolUseId: use.id,
    isError: true,
    content: json({
      refused: refusal.reason,
      retry: refusal.retry,
      ...(refusal.details === undefined ||
      Object.keys(refusal.details).length === 0
        ? {}
        : { details: refusal.details }),
    }),
  };
}

function textOf(response: ModelResponse): string {
  return response.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** JSON with every object's keys in order, so one input reads one way. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, held: unknown) =>
    typeof held === "object" && held !== null && !Array.isArray(held)
      ? Object.fromEntries(
          Object.entries(held).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : held,
  );
}
