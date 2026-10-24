import type { ActionRequest } from "@openbrf/plugin-sdk";

import type { ListedAction, ListFilter } from "../src/host-contract.ts";
import { ActionRefusalStandIn } from "./stand-in-archive.ts";

/**
 * A stand-in for the core's issue reads, `issue_get` and `issue_type_list`,
 * at the boundary the package reads them: `host.actions.list` and
 * `host.actions.invoke`. It answers in the shapes the core's
 * `issue-actions.registrar.ts` publishes and refuses as the registry does.
 *
 * It also offers the queue's writes a model would reach for, and the host's
 * `propose`, so that a test can show the package calls none of them: every
 * call to `invoke` and to `propose` is kept.
 */

export interface StandInIssue {
  id: string;
  status: "NEW" | "IN_PROGRESS" | "DONE";
  type: { id: string; name: string; audience: string };
  location: string | null;
  description: string;
  apartment: { id: string; number: string; address: string } | null;
  reporter:
    | { kind: "resident"; personId: string; name: string }
    | { kind: "external"; name: string | null }
    | { kind: "unknown" };
  photoCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export const TYPES = [
  {
    id: "type-water",
    title: "Vatten och avlopp",
    audience: "MEMBER",
    active: true,
  },
  {
    id: "type-lock",
    title: "Lås och dörrar",
    audience: "MEMBER",
    active: true,
  },
  { id: "type-laundry", title: "Tvättstuga", audience: "MEMBER", active: true },
  {
    id: "type-outdoor",
    title: "Utemiljö",
    audience: "NON_MEMBER",
    active: true,
  },
  {
    id: "type-old",
    title: "Övrigt (gammal)",
    audience: "MEMBER",
    active: false,
  },
] as const;

export const LEAK: StandInIssue = {
  id: "issue-leak",
  status: "NEW",
  type: { id: "type-laundry", name: "Tvättstuga", audience: "MEMBER" },
  location: "Badrummet",
  description:
    "Det droppar från taket i badrummet sedan i morse, och det blir mer. Grannen ovanför svarar inte.",
  apartment: { id: "apartment-1", number: "1101", address: "Storgatan 12" },
  reporter: { kind: "resident", personId: "person-rut", name: "Rut Ek" },
  photoCount: 1,
  createdAt: "2026-10-23T06:12:00.000Z",
  updatedAt: "2026-10-23T06:12:00.000Z",
  closedAt: null,
};

export const EXTERNAL: StandInIssue = {
  ...LEAK,
  id: "issue-external",
  type: { id: "type-outdoor", name: "Utemiljö", audience: "NON_MEMBER" },
  location: "Gården",
  description: "The gate to the courtyard does not close behind you.",
  apartment: null,
  reporter: { kind: "external", name: "Visitor" },
  photoCount: 0,
};

/** The listing, as the core publishes it, in short. */
const LISTED: readonly ListedAction[] = [
  {
    name: "issue_list",
    title: "List issues",
    description: "Reads one page of the issue queue.",
    group: "issues",
    effect: "read",
    personalData: ["name", "apartment", "freeText", "health"],
    inputSchema: { type: "object" },
  },
  {
    name: "issue_get",
    title: "Read an issue",
    description: "Reads one issue from the queue.",
    group: "issues",
    effect: "read",
    personalData: ["name", "apartment", "freeText", "health"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "issue_type_list",
    title: "List issue types",
    description: "Lists the issue types the board has set up for reports.",
    group: "issues",
    effect: "read",
    personalData: [],
    inputSchema: { type: "object", additionalProperties: false },
  },
];

export interface Dispatched {
  request: ActionRequest;
  name: string;
  input: unknown;
}

export class StandInIssues {
  readonly issues = new Map<string, StandInIssue>();
  readonly listed: {
    request: ActionRequest;
    filter: ListFilter | undefined;
  }[] = [];
  readonly dispatched: Dispatched[] = [];
  readonly proposed: Dispatched[] = [];
  /** What `list` answers with; the core's three reads unless a test says. */
  offered: ListedAction[] = [...LISTED];
  types: readonly Record<string, unknown>[] = TYPES;

  constructor(issues: readonly StandInIssue[] = [LEAK, EXTERNAL]) {
    for (const issue of issues) {
      this.issues.set(issue.id, issue);
    }
  }

  list = async (
    request: ActionRequest,
    filter?: ListFilter,
  ): Promise<ListedAction[]> => {
    this.listed.push({ request, filter });
    return this.offered.filter(
      (action) => filter?.group === undefined || action.group === filter.group,
    );
  };

  invoke = async <Output>(
    request: ActionRequest,
    name: string,
    input: unknown,
  ): Promise<Output> => {
    this.dispatched.push({ request, name, input });
    if (name === "issue_type_list") {
      return { types: this.types } as Output;
    }
    if (name === "issue_get") {
      const id = (input as { id?: unknown } | null)?.id;
      const issue = typeof id === "string" ? this.issues.get(id) : undefined;
      if (issue === undefined) {
        throw new ActionRefusalStandIn("domain", "issue-not-found", "never");
      }
      return structuredClone(issue) as Output;
    }
    throw new ActionRefusalStandIn("registry", "unknown-action", "never");
  };

  propose = async (
    request: ActionRequest,
    name: string,
    input: unknown,
  ): Promise<unknown> => {
    this.proposed.push({ request, name, input });
    return { id: "pending-1" };
  };

  /** The names `invoke` was called with, in order. */
  names(): string[] {
    return this.dispatched.map((each) => each.name);
  }
}
