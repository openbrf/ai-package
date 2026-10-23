import type {
  AiPackageHost,
  EntitlementState,
  JsonValue,
  PluginRecipientRequest,
  PluginRecipientResponse,
  PluginRecord,
  PluginRecords,
} from "../src/host-contract.ts";
import type {
  ModelCall,
  ModelProvider,
  ModelResponse,
} from "../src/provider.ts";

/**
 * Stand-ins for the host members the package reads, at the boundary it reads
 * them: settings, the licence finding, the package's own records and the way
 * out to its recipient. The real ones are the host's and are tested there.
 */

export const ACTIVE: EntitlementState = {
  status: "active",
  licenceId: "lic-1",
  validUntil: "2027-11-30",
  updatesUntil: null,
};

/** Lets every other pending callback run, as a database round trip would. */
const yieldTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

class RecordConflict extends Error {
  constructor() {
    super("conflict");
    this.name = "PluginRecordConflictError";
  }
}

/**
 * The package's records in memory, with the host's revision rule: a write
 * over a revision the store no longer holds is refused. Every read and write
 * yields first, so two callers interleave as two requests would.
 */
export class MemoryRecords implements PluginRecords {
  readonly rows = new Map<string, PluginRecord>();
  writes = 0;

  async get<Value extends JsonValue>(
    collection: string,
    key: string,
  ): Promise<PluginRecord<Value> | null> {
    await yieldTurn();
    return (this.rows.get(`${collection}/${key}`) ??
      null) as PluginRecord<Value> | null;
  }

  async list<Value extends JsonValue>(
    collection: string,
    options: { after?: string; limit?: number } = {},
  ): Promise<readonly PluginRecord<Value>[]> {
    await yieldTurn();
    const { after, limit = 200 } = options;
    return [...this.rows.values()]
      .filter(
        (record) =>
          record.collection === collection &&
          (after === undefined || record.key > after),
      )
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, limit) as PluginRecord<Value>[];
  }

  async put<Value extends JsonValue>(
    collection: string,
    key: string,
    value: Value,
    options: { expectedRevision?: number | null } = {},
  ): Promise<PluginRecord<Value>> {
    await yieldTurn();
    const id = `${collection}/${key}`;
    const current = this.rows.get(id) ?? null;
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== (current?.revision ?? null)
    ) {
      throw new RecordConflict();
    }
    const record: PluginRecord<Value> = {
      collection,
      key,
      value: structuredClone(value),
      revision: (current?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(id, record);
    this.writes++;
    return record;
  }

  async delete(
    collection: string,
    key: string,
    options: { expectedRevision?: number } = {},
  ): Promise<boolean> {
    await yieldTurn();
    const id = `${collection}/${key}`;
    const current = this.rows.get(id);
    if (current === undefined) {
      return false;
    }
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== current.revision
    ) {
      throw new RecordConflict();
    }
    return this.rows.delete(id);
  }

  /** The records of a collection, by key. */
  keys(collection: string): string[] {
    return [...this.rows.values()]
      .filter((record) => record.collection === collection)
      .map((record) => record.key)
      .sort();
  }

  value(collection: string, key: string): JsonValue | undefined {
    return this.rows.get(`${collection}/${key}`)?.value;
  }
}

export interface Sent {
  id: string;
  path: string;
  init: PluginRecipientRequest | undefined;
}

/** The way out, answering with what a test queues. */
export class StandInRecipients {
  readonly sent: Sent[] = [];
  readonly answers: (PluginRecipientResponse | Error)[] = [];

  answer(status: number, body: unknown, headers: Record<string, string> = {}) {
    const bytes = new TextEncoder().encode(
      typeof body === "string" ? body : JSON.stringify(body),
    );
    this.answers.push({
      status,
      headers,
      body: bytes,
      text: () => new TextDecoder().decode(bytes),
      json: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    });
  }

  fail(code: string) {
    this.answers.push(
      Object.assign(new Error(`could not reach: ${code}`), {
        name: "PluginRecipientError",
        code,
      }),
    );
  }

  async fetch(
    id: string,
    path: string,
    init?: PluginRecipientRequest,
  ): Promise<PluginRecipientResponse> {
    this.sent.push({ id, path, init });
    const next = this.answers.shift();
    if (next === undefined) {
      throw new Error("No answer queued.");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

/** A provider that answers what a test queues and keeps what it was asked. */
export class FakeProvider implements ModelProvider {
  readonly name = "Fake";
  readonly calls: ModelCall[] = [];
  readonly answers: (ModelResponse | Error)[] = [];
  /** When set, every call waits for it before answering. */
  gate: Promise<void> | null = null;

  constructor(readonly model = "fake-model") {}

  async complete(call: ModelCall): Promise<ModelResponse> {
    this.calls.push(call);
    await this.gate;
    await yieldTurn();
    const next = this.answers.shift() ?? answer();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

export function answer(
  usage: Partial<ModelResponse["usage"]> = {},
  text = "Ett utkast.",
): ModelResponse {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    stop: "end",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...usage,
    },
    model: "fake-model",
  };
}

export interface StandIn {
  host: AiPackageHost;
  settings: Record<string, unknown>;
  records: MemoryRecords;
  recipients: StandInRecipients;
  entitlement: { state: EntitlementState };
  logged: { level: string; message: string }[];
}

export interface StandInOptions {
  /** Leave out a member, as an older host does. */
  without?: readonly ("recipients" | "records" | "entitlements")[];
  settings?: Record<string, unknown>;
  entitlement?: EntitlementState;
  /** Whether `actions.client` names a connected app for every request. */
  connectedApp?: boolean;
  /** The host's action dispatch, in place of one that offers nothing. */
  actions?: Pick<AiPackageHost["actions"], "list" | "invoke">;
}

export function standIn(options: StandInOptions = {}): StandIn {
  const without = new Set(options.without ?? []);
  const settings: Record<string, unknown> = {
    apiKey: "sk-ant-test-key",
    model: "claude-opus-5-5",
    monthlyTokenLimit: 2_000_000,
    requestsPerMinute: 10,
    ...options.settings,
  };
  const records = new MemoryRecords();
  const recipients = new StandInRecipients();
  const entitlement = { state: options.entitlement ?? ACTIVE };
  const logged: StandIn["logged"] = [];
  const log =
    (level: string) =>
    (message: string): void => {
      logged.push({ level, message });
    };

  const host = {
    id: "ai-package",
    permissions: [],
    logger: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    settings: { read: async () => ({ ...settings }) },
    actions: {
      register: () => undefined,
      list: async () => [],
      invoke: async () => undefined,
      ...options.actions,
      client: () =>
        options.connectedApp === true
          ? { clientId: "client-1", clientHost: "client.example" }
          : null,
    },
    ...(without.has("recipients") ? {} : { recipients }),
    ...(without.has("records") ? {} : { records }),
    ...(without.has("entitlements")
      ? {}
      : { entitlements: { get: async () => entitlement.state } }),
  } as unknown as AiPackageHost;

  return { host, settings, records, recipients, entitlement, logged };
}
