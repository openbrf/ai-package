import type { ActionRequest, PluginHost } from "@openbrf/plugin-sdk";

/**
 * The parts of the host this package reads that are newer than the plugin
 * SDK release it builds against.
 *
 * Each is written as the SDK declares it in `openbrf/openbrf`, and each is
 * read as optional: a host older than the member answers without it, and the
 * package has to tell that host apart rather than fail on a missing method.
 * Replace each with the SDK's own export once a release carries it.
 */

/** `EntitlementState`: the host's finding on this plugin's licence (ADR 0042). */
export type EntitlementState =
  | {
      status: "active";
      licenceId: string;
      validUntil: string | null;
      updatesUntil: string | null;
    }
  | { status: "absent" }
  | { status: "expired"; licenceId: string; validUntil: string }
  | {
      status: "version-not-covered";
      licenceId: string;
      updatesUntil: string;
      released: string;
    }
  | { status: "wrong-instance"; licenceId: string }
  | { status: "tampered" }
  | { status: "not-yet-valid"; licenceId: string; issuedOn: string };

/** `PluginEntitlements`. */
export interface PluginEntitlements {
  get(): Promise<EntitlementState>;
  present(audience: string): Promise<string | null>;
}

/** `PluginPersonalDataCategory`: the categories a manifest may declare. */
export type PersonalDataCategory =
  | "name"
  | "apartment"
  | "residency"
  | "email"
  | "phone"
  | "postalAddress"
  | "account"
  | "financial"
  | "health"
  | "photograph"
  | "freeText"
  | "auditTrail";

/** `PluginDisclosure`: what a request to a recipient sends, and about whom. */
export interface PluginDisclosure {
  readonly personalData: readonly PersonalDataCategory[];
  readonly subjects: readonly string[];
}

/** `PluginRecipientRequest`. */
export interface PluginRecipientRequest {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  disclosure?: PluginDisclosure;
  timeoutMs?: number;
}

/** `PluginRecipientResponse`. */
export interface PluginRecipientResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  text(): string;
  json(): unknown;
}

/** `PluginRecipients`: the way out to the recipients the manifest declares. */
export interface PluginRecipients {
  fetch(
    id: string,
    path: string,
    init?: PluginRecipientRequest,
  ): Promise<PluginRecipientResponse>;
}

/** `JsonValue`: what a record may hold. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** `PluginRecord`. */
export interface PluginRecord<Value extends JsonValue = JsonValue> {
  readonly collection: string;
  readonly key: string;
  readonly value: Value;
  readonly revision: number;
  readonly updatedAt: string;
}

/** `PluginRecords`: the plugin's own records (ADR 0033). */
export interface PluginRecords {
  get<Value extends JsonValue>(
    collection: string,
    key: string,
  ): Promise<PluginRecord<Value> | null>;
  list<Value extends JsonValue>(
    collection: string,
    options?: { after?: string; limit?: number },
  ): Promise<readonly PluginRecord<Value>[]>;
  put<Value extends JsonValue>(
    collection: string,
    key: string,
    value: Value,
    options?: { expectedRevision?: number | null },
  ): Promise<PluginRecord<Value>>;
  delete(
    collection: string,
    key: string,
    options?: { expectedRevision?: number },
  ): Promise<boolean>;
}

/**
 * Whether a record write was refused because another write got there first.
 *
 * Read by its name, as the SDK says to: the host throws its own copy of the
 * class, which is not this bundle's.
 */
export function isRecordConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "PluginRecordConflictError";
}

/** `PluginRecipientError`, read by its name for the same reason. */
export function recipientErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "PluginRecipientError") {
    return null;
  }
  const { code } = error as Error & { code?: unknown };
  return typeof code === "string" ? code : null;
}

/** `ActionClient`: the connected app a request was authenticated with. */
export interface ActionClient {
  readonly clientId: string;
  readonly clientHost: string | null;
}

/**
 * `ActionWithSchemas`: one action as `host.actions.list` hands it to a plugin
 * (ADR 0038, "Schemas in process"), with the fields this package reads.
 *
 * A host older than the schemas lists the action without them, and the
 * package offers a model no tool it cannot describe.
 */
export interface ActionWithSchemas {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly group: string;
  readonly effect: "read" | "write" | "delete";
  readonly inputSchema?: Record<string, unknown>;
}

/**
 * `PendingChangeReceipt`: what proposing a change answers with (ADR 0039).
 * Nothing has run; the person confirms or rejects it at `path`.
 */
export interface PendingChangeReceipt {
  readonly id: string;
  readonly expiresAt: Date;
  readonly path: string;
}

/** `PluginActions`, with the members newer than the SDK where the host has them. */
export type AiPackageActions = Omit<PluginHost["actions"], "list"> & {
  readonly list: (
    request: ActionRequest,
    filter?: {
      readonly surface?: "ui" | "mcp" | "ai";
      readonly group?: string;
    },
  ) => Promise<readonly ActionWithSchemas[]>;
  readonly propose?: (
    request: ActionRequest,
    name: string,
    input: unknown,
  ) => Promise<PendingChangeReceipt>;
  readonly client?: (request: ActionRequest) => ActionClient | null;
};

/**
 * `ActionRefusal`, with the fields this package hands a model: why the call
 * was refused, whether trying again could work, and for an input the action
 * refused, which fields. Never the input itself.
 */
export interface ActionRefusalFinding {
  readonly reason: string;
  readonly retry: string;
  readonly details: Readonly<Record<string, readonly unknown[]>>;
}

/**
 * The refusal an action call was answered with, or null for anything else.
 * Read by its name, as `isActionRefusal` in the SDK reads it, for the reason
 * `isRecordConflict` gives.
 */
export function actionRefusalOf(error: unknown): ActionRefusalFinding | null {
  if (!(error instanceof Error) || error.name !== "ActionRefusal") {
    return null;
  }
  const refusal = error as Error & {
    reason?: unknown;
    retry?: unknown;
    details?: unknown;
  };
  if (typeof refusal.reason !== "string" || typeof refusal.retry !== "string") {
    return null;
  }
  let details: Readonly<Record<string, readonly unknown[]>> = {};
  if (typeof refusal.details === "function") {
    try {
      const read: unknown = (refusal.details as () => unknown).call(error);
      if (typeof read === "object" && read !== null) {
        details = read as Record<string, readonly unknown[]>;
      }
    } catch {
      // A refusal whose details cannot be read is still a refusal.
    }
  }
  return { reason: refusal.reason, retry: refusal.retry, details };
}

/** The host object, with the members above where the host has them. */
export type AiPackageHost = Omit<PluginHost, "actions"> & {
  readonly actions: AiPackageActions;
  readonly recipients?: PluginRecipients;
  readonly records?: PluginRecords;
  readonly entitlements?: PluginEntitlements;
};
