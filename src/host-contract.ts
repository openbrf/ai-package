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
 * `ActionWithSchemas`: one action as `host.actions.list` offers it, with the
 * JSON Schema of what it takes and what it returns (ADR 0038). A host from
 * before the schemas lists the summary alone, so both are optional here.
 */
export interface ListedAction {
  readonly name: string;
  readonly description: string;
  readonly group: string;
  readonly personalData: readonly string[];
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

/** `PluginActionFilter`. */
export interface ListFilter {
  readonly surface?: "ui" | "mcp" | "ai";
  readonly group?: string;
}

/** `PluginActions`, with the listing's schemas and `client` where the host has them. */
export type AiPackageActions = Omit<PluginHost["actions"], "list"> & {
  readonly list: (
    request: ActionRequest,
    filter?: ListFilter,
  ) => Promise<ListedAction[]>;
  readonly client?: (request: ActionRequest) => ActionClient | null;
};

/** `ActionRefusal`: what `host.actions.invoke` rejects with when it refused. */
export interface ActionRefusalFields {
  readonly kind: "registry" | "invalid-body" | "domain";
  readonly reason: string;
  readonly retry: "never" | "after-edit" | "after-backoff";
  /** For an invalid body, each failing field's path and message. */
  readonly issues: readonly unknown[];
}

/**
 * The refusal an `invoke` rejected with, or null when it failed rather than
 * being refused. Read by its fields, as the SDK's `isActionRefusal` reads it:
 * the host builds the error, and this bundle has no copy of its class.
 */
export function actionRefusalOf(error: unknown): ActionRefusalFields | null {
  if (!(error instanceof Error) || error.name !== "ActionRefusal") {
    return null;
  }
  const { kind, reason, retry, details } = error as Error &
    Partial<Record<"kind" | "reason" | "retry" | "details", unknown>>;
  if (
    (kind !== "registry" && kind !== "invalid-body" && kind !== "domain") ||
    typeof reason !== "string" ||
    (retry !== "never" && retry !== "after-edit" && retry !== "after-backoff")
  ) {
    return null;
  }
  let issues: readonly unknown[] = [];
  if (typeof details === "function") {
    const published = (details as () => unknown).call(error);
    const listed = (published as { issues?: unknown } | null)?.issues;
    issues = Array.isArray(listed) ? listed : [];
  }
  return { kind, reason, retry, issues };
}

/** The host object, with the members above where the host has them. */
export type AiPackageHost = Omit<PluginHost, "actions"> & {
  readonly actions: AiPackageActions;
  readonly recipients?: PluginRecipients;
  readonly records?: PluginRecords;
  readonly entitlements?: PluginEntitlements;
};
