import type { ActionRequest } from "@openbrf/plugin-sdk";

import type {
  AiPackageActions,
  ListedAction,
  PendingChangeReceipt,
} from "../src/host-contract.ts";
import type { ModelResponse, ModelToolUse } from "../src/provider.ts";
import { ActionRefusalStandIn } from "./stand-in-archive.ts";

export { ActionRefusalStandIn };

/**
 * A stand-in for `host.actions` as an AI package's route sees it: the actions
 * offered on `ai`, reads that answer what a test gives them, and proposals
 * that are held and answered with a receipt, as the host's queue holds them.
 *
 * `invoke` refuses a write with `confirmation-required`, as the host does on
 * `ai`, so a test that let a write through `invoke` would see it refused
 * rather than pass quietly; `written` records the attempt either way.
 */

const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  additionalProperties: false,
};

function action(
  name: string,
  group: string,
  effect: ListedAction["effect"],
): ListedAction {
  return {
    name,
    title: `Title of ${name}`,
    description: `Description of ${name}.`,
    group,
    effect,
    personalData: ["name", "freeText"],
    inputSchema: SCHEMA,
  };
}

/** What the host offers on `ai` after ADR 0038's "News and pages on `ai`". */
export const OFFERED: readonly ListedAction[] = [
  action("news_list", "news", "read"),
  action("news_get", "news", "read"),
  action("news_create", "news", "write"),
  action("news_update", "news", "write"),
  action("news_publish", "news", "write"),
  action("news_request_mailing", "news", "write"),
  action("page_get", "pages", "read"),
  action("page_update", "pages", "write"),
  // Offered on `ai` but in a group the site assistant does not work with.
  action("document_list", "documents", "read"),
];

export interface Held {
  name: string;
  input: unknown;
  receipt: PendingChangeReceipt;
}

export class StandInActions {
  offered: readonly ListedAction[] = OFFERED;
  readonly listed: { request: ActionRequest; filter: unknown }[] = [];
  readonly reads: { name: string; input: unknown }[] = [];
  readonly written: { name: string; input: unknown }[] = [];
  readonly held: Held[] = [];
  /** What a read answers, by action name. */
  readonly answers = new Map<string, unknown>();
  /** A refusal a proposal of an action is answered with, by action name. */
  readonly refusals = new Map<string, Error>();
  withPropose = true;
  /** Called with each read, before it is answered. */
  onRead: (name: string) => void = () => undefined;

  asHost(): AiPackageActions {
    const actions = {
      register: () => undefined,
      list: async (request: ActionRequest, filter?: unknown) => {
        this.listed.push({ request, filter });
        return this.offered.map((offered) => ({ ...offered }));
      },
      invoke: async <Output>(
        _request: ActionRequest,
        name: string,
        input: unknown,
      ): Promise<Output> => {
        const offered = this.offered.find((held) => held.name === name);
        if (offered?.effect !== "read") {
          this.written.push({ name, input });
          throw new ActionRefusalStandIn(
            "registry",
            "confirmation-required",
            "never",
          );
        }
        this.reads.push({ name, input });
        this.onRead(name);
        return (this.answers.get(name) ?? {}) as Output;
      },
      client: () => null,
      ...(this.withPropose
        ? {
            propose: async (
              _request: ActionRequest,
              name: string,
              input: unknown,
            ): Promise<PendingChangeReceipt> => {
              const refusal = this.refusals.get(name);
              if (refusal !== undefined) {
                throw refusal;
              }
              const id = `change-${String(this.held.length + 1)}`;
              const receipt = {
                id,
                expiresAt: new Date("2026-10-29T09:41:12Z"),
                path: `/app/pending-changes/${id}`,
              };
              this.held.push({ name, input, receipt });
              return receipt;
            },
          }
        : {}),
    };
    return actions as unknown as AiPackageActions;
  }
}

/** The model asking for tools, as one response. */
export function toolUse(
  ...uses: { name: string; input: unknown; id?: string }[]
): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: uses.map((use, index): ModelToolUse => ({
        type: "tool_use",
        id: use.id ?? `use-${use.name}-${String(index)}`,
        name: use.name,
        input: use.input,
      })),
    },
    stop: "tool-use",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    model: "fake-model",
  };
}
