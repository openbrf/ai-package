import { describe, expect, it } from "vitest";

import type { JsonValue, PluginRecord } from "../src/host-contract.ts";
import type { ModelUsage } from "../src/provider.ts";
import {
  CALLS_COLLECTION,
  USAGE_COLLECTION,
  UsageMeter,
} from "../src/usage.ts";
import { MemoryRecords } from "./stand-in-host.ts";

/**
 * How the meter keeps a month's count when writes to its totals fail or
 * race: each call counts from its own record until its month's totals
 * include it, and never twice.
 */

const USED: ModelUsage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

class Conflict extends Error {
  constructor() {
    super("conflict");
    this.name = "PluginRecordConflictError";
  }
}

/** The records in memory, with a test's say over each call to them. */
class ScriptedRecords extends MemoryRecords {
  /** Throws instead of writing a month's totals while it says so. */
  refuseTotals: (() => Error | null) | null = null;
  /** Throws instead of deleting a call record while it says so. */
  refuseDelete: (() => Error | null) | null = null;
  /** Runs before a list, as another process could at that moment. */
  beforeList: (() => Promise<void>) | null = null;

  override async put<Value extends JsonValue>(
    collection: string,
    key: string,
    value: Value,
    options?: { expectedRevision?: number | null },
  ): Promise<PluginRecord<Value>> {
    const refusal =
      collection === USAGE_COLLECTION && key.startsWith("month:")
        ? this.refuseTotals?.()
        : null;
    if (refusal) {
      throw refusal;
    }
    return super.put(collection, key, value, options);
  }

  override async delete(
    collection: string,
    key: string,
    options?: { expectedRevision?: number },
  ): Promise<boolean> {
    const refusal =
      collection === CALLS_COLLECTION ? this.refuseDelete?.() : null;
    if (refusal) {
      throw refusal;
    }
    return super.delete(collection, key, options);
  }

  override async list<Value extends JsonValue>(
    collection: string,
    options?: { after?: string; limit?: number },
  ): Promise<readonly PluginRecord<Value>[]> {
    const before = this.beforeList;
    this.beforeList = null;
    await before?.();
    return super.list(collection, options);
  }
}

function meter(records: MemoryRecords, now = "2026-10-22T09:41:12Z") {
  return new UsageMeter(records, () => new Date(now));
}

describe("a call's use", () => {
  it("counts from its own record when every write to the totals loses", async () => {
    const records = new ScriptedRecords();
    records.refuseTotals = () => new Conflict();
    const usage = meter(records);

    await usage.record(USED);

    expect(await usage.settle()).toBe(false);
    expect((await usage.thisMonth()).usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      calls: 1,
    });
    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toBeUndefined();

    records.refuseTotals = null;
    expect(await usage.settle()).toBe(true);
    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toMatchObject({
      inputTokens: 100,
      calls: 1,
    });
    expect(records.keys(CALLS_COLLECTION)).toEqual([]);
  });

  it("is counted once when its record outlives the write that added it to the totals", async () => {
    const records = new ScriptedRecords();
    const usage = meter(records);
    await usage.record(USED);
    // The process stops after writing the totals and before deleting the
    // call record.
    records.refuseDelete = () => new Error("stopped");

    await expect(usage.settle()).rejects.toThrow("stopped");

    expect(records.keys(CALLS_COLLECTION)).toHaveLength(1);
    expect((await usage.thisMonth()).usage.calls).toBe(1);

    records.refuseDelete = null;
    await usage.record(USED);
    expect(await usage.settle()).toBe(true);
    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toMatchObject({
      inputTokens: 200,
      calls: 2,
    });
    expect(records.keys(CALLS_COLLECTION)).toEqual([]);
  });

  it("is added to its own month when the month ends before it is settled", async () => {
    const records = new ScriptedRecords();
    // 23:59 on 31 October in Stockholm.
    const october = meter(records, "2026-10-31T22:59:00Z");
    await october.record(USED);

    const november = meter(records, "2026-10-31T23:00:00Z");
    await november.record({ ...USED, inputTokens: 300 });
    expect(await november.settle()).toBe(true);

    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toMatchObject({
      inputTokens: 100,
      calls: 1,
    });
    expect(records.value(USAGE_COLLECTION, "month:2026-11")).toMatchObject({
      inputTokens: 300,
      calls: 1,
    });
    expect(records.keys(CALLS_COLLECTION)).toEqual([]);
  });

  it("is counted once when another process adds it to the totals during a read", async () => {
    const records = new ScriptedRecords();
    const usage = meter(records);
    await usage.record(USED);
    // Between the read of the totals and the read of the call records,
    // another process adds the call to the totals and deletes its record.
    records.beforeList = async () => {
      expect(await meter(records).settle()).toBe(true);
    };

    expect((await usage.thisMonth()).usage).toMatchObject({
      inputTokens: 100,
      calls: 1,
    });
  });

  it("adds more calls than one write takes, in turns", async () => {
    const records = new ScriptedRecords();
    const usage = meter(records);
    for (let call = 0; call < 250; call++) {
      await usage.record(USED);
    }

    expect((await usage.thisMonth()).usage.calls).toBe(250);
    expect(await usage.settle()).toBe(true);

    expect(records.value(USAGE_COLLECTION, "month:2026-10")).toMatchObject({
      inputTokens: 25_000,
      calls: 250,
    });
    expect(records.keys(CALLS_COLLECTION)).toEqual([]);
  });
});
