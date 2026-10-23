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
 * `PendingChangeReceipt`: a write held for the person to confirm (ADR 0039).
 * Nothing has run; the person confirms or rejects it at `path`.
 */
export interface PendingChangeReceipt {
  readonly id: string;
  readonly expiresAt: Date;
  /** The preview, on the platform's own screen, relative to the origin. */
  readonly path: string;
}

/** `PluginActions`, with `client` and `propose` where the host has them. */
export type AiPackageActions = PluginHost["actions"] & {
  readonly client?: (request: ActionRequest) => ActionClient | null;
  readonly propose?: (
    request: ActionRequest,
    name: string,
    input: unknown,
  ) => Promise<PendingChangeReceipt>;
};

/** The host object, with the members above where the host has them. */
export type AiPackageHost = Omit<PluginHost, "actions"> & {
  readonly actions: AiPackageActions;
  readonly recipients?: PluginRecipients;
  readonly records?: PluginRecords;
  readonly entitlements?: PluginEntitlements;
};
