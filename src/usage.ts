import { randomUUID } from "node:crypto";

import {
  isRecordConflict,
  type PluginRecord,
  type PluginRecords,
} from "./host-contract.ts";
import { type ModelUsage, totalTokens } from "./provider.ts";

/**
 * The instance's use of the model: a monthly limit in tokens and a limit on
 * calls per minute, both the board's to set.
 *
 * Kept in the package's own records (ADR 0033), so every process serving the
 * instance counts against the same figures. Nothing in them is about a
 * person: a month's totals, each call's token counts and the current minute's
 * count, never who asked or what for.
 *
 * Two writers can read the same revision of a month's totals, and only one of
 * them can write over it. So a call's use is first written as a record of its
 * own, under a key no other writer uses, and only then added to the month's
 * totals. Until it is added, the call counts from its own record: reading a
 * month adds the call records its totals do not yet include. A call that loses
 * every attempt to add itself is added by a later call. The totals name the
 * call records their last write added, so a call record left behind between
 * that write and its deletion is not counted twice.
 *
 * A month is read exactly when its totals stay the same during the read. When
 * they change during every attempt, it is read in a way that may count a call
 * twice, but still counts every call whose record was written before the read.
 *
 * The monthly limit is checked before a call, and a call already under way is
 * let finish, so a month can end over its limit by what the calls under way at
 * that moment used; the per-minute limit bounds how many those are.
 */

export const USAGE_COLLECTION = "usage";

/** Each call's use, until it is added to its month's totals. */
export const CALLS_COLLECTION = "usage-calls";

const RATE_KEY = "rate";

/** How often a write is tried again after losing to another writer. */
const ATTEMPTS = 8;

/** The most call records one write adds to a month, to keep its record small. */
const BATCH = 100;

/** The most records one `list` returns. */
const LIST_LIMIT = 200;

/** A month's totals, as stored. */
export interface MonthUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly calls: number;
}

interface RateWindow {
  /** The minute the count is for, in UTC: `2026-10-22T09:41`. */
  readonly minute: string;
  readonly count: number;
}

export interface UsageLimits {
  /** Tokens per calendar month; 0 stops every call. */
  readonly monthlyTokenLimit: number;
  readonly requestsPerMinute: number;
}

export type Admission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: "usage-limit-reached" }
  | {
      readonly admitted: false;
      readonly reason: "rate-limited";
      readonly retryAfterSeconds: number;
    };

const NO_USAGE: MonthUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  calls: 0,
};

/** A month's totals as read, with the call records they include. */
interface MonthState {
  readonly record: PluginRecord<MonthUsageValue> | null;
  readonly totals: MonthUsage;
  /** The call records the totals' last write added. */
  readonly counted: ReadonlySet<string>;
  /** The month's call records, in key order. */
  readonly calls: readonly PluginRecord<CallUsageValue>[];
}

export class UsageMeter {
  constructor(
    private readonly records: PluginRecords,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * This month's totals, with every call whose own record they do not yet
   * include, and which month it is.
   */
  async thisMonth(): Promise<{ month: string; usage: MonthUsage }> {
    const month = stockholmMonth(this.now());
    // The totals and the call records are two reads. When the totals changed
    // in between, call records may have been added to them and deleted, so
    // that neither read has them: such a read is not used, and both are read
    // again.
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const state = await this.monthState(month);
      const after = await this.records.get<MonthUsageValue>(
        USAGE_COLLECTION,
        monthKey(month),
      );
      if ((after?.revision ?? null) === (state.record?.revision ?? null)) {
        return { month, usage: monthTotal(state) };
      }
    }
    // The totals changed during every read. Read in the other order, the call
    // records and then the totals: a call record deleted before it was listed
    // was added to the totals first, and the totals only grow, so every call
    // whose record was written before this read counts. A call record added to
    // the totals after it was listed may count twice, which errs towards the
    // limit.
    const calls = await this.callRecords(month);
    const record = await this.records.get<MonthUsageValue>(
      USAGE_COLLECTION,
      monthKey(month),
    );
    return {
      month,
      usage: monthTotal({
        record,
        totals: monthUsage(record),
        counted: countedCalls(record),
        calls,
      }),
    };
  }

  /**
   * Whether a call may go ahead now. An admitted call is counted against the
   * current minute at once, so two callers cannot both take the last place.
   */
  async admit(limits: UsageLimits): Promise<Admission> {
    const { usage } = await this.thisMonth();
    if (totalTokens(usage) >= limits.monthlyTokenLimit) {
      return { admitted: false, reason: "usage-limit-reached" };
    }

    // A write that loses to another caller is tried again, however many
    // there are: each loss means another caller was admitted, and the count
    // only grows within a minute, so this ends at the limit or at a write.
    for (;;) {
      const now = this.now();
      const minute = utcMinute(now);
      const record = await this.records.get<RateWindowValue>(
        USAGE_COLLECTION,
        RATE_KEY,
      );
      const window = rateWindow(record);
      const count = window?.minute === minute ? window.count : 0;
      if (count >= limits.requestsPerMinute) {
        return {
          admitted: false,
          reason: "rate-limited",
          retryAfterSeconds: secondsToNextMinute(now),
        };
      }
      try {
        await this.records.put<RateWindowValue>(
          USAGE_COLLECTION,
          RATE_KEY,
          { minute, count: count + 1 },
          { expectedRevision: record?.revision ?? null },
        );
        return { admitted: true };
      } catch (error) {
        if (!isRecordConflict(error)) {
          throw error;
        }
      }
    }
  }

  /**
   * Counts what a call used towards this month, in a record of the call's
   * own. Once this resolves the call counts; it throws only when the store
   * refuses that one write. `settle` then adds it to the month's totals.
   */
  async record(used: ModelUsage): Promise<void> {
    const month = stockholmMonth(this.now());
    await this.records.put<CallUsageValue>(
      CALLS_COLLECTION,
      `${month}:${randomUUID()}`,
      {
        inputTokens: used.inputTokens,
        outputTokens: used.outputTokens,
        cacheReadTokens: used.cacheReadTokens,
        cacheWriteTokens: used.cacheWriteTokens,
      },
      { expectedRevision: null },
    );
  }

  /**
   * Adds the call records of this month, and of the earliest month that still
   * has any, to their months' totals, and deletes them. False when another
   * writer won every attempt, which leaves the calls counted from their own
   * records until a later call settles them.
   */
  async settle(): Promise<boolean> {
    const month = stockholmMonth(this.now());
    const settled = await this.settleMonth(month);
    // A call that finished as a month ended, and was not settled then.
    const [oldest] = await this.records.list<CallUsageValue>(CALLS_COLLECTION, {
      limit: 1,
    });
    const earlier = oldest === undefined ? null : callMonth(oldest.key);
    if (earlier === null || earlier === month) {
      return settled;
    }
    return (await this.settleMonth(earlier)) && settled;
  }

  private async settleMonth(month: string): Promise<boolean> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const state = await this.monthState(month);
      const uncounted: PluginRecord<CallUsageValue>[] = [];
      for (const call of state.calls) {
        if (state.counted.has(call.key)) {
          // In the totals already; the write that added it stopped short of
          // deleting it. Deleted before the totals are written again, which
          // forgets that they include it.
          await this.records.delete(CALLS_COLLECTION, call.key);
        } else {
          uncounted.push(call);
        }
      }
      if (uncounted.length === 0) {
        return true;
      }
      const batch = uncounted.slice(0, BATCH);
      const totals = withCalls(state.totals, batch);
      try {
        await this.records.put<MonthUsageValue>(
          USAGE_COLLECTION,
          monthKey(month),
          { ...totals, counted: batch.map((call) => call.key) },
          { expectedRevision: state.record?.revision ?? null },
        );
      } catch (error) {
        if (!isRecordConflict(error)) {
          throw error;
        }
        continue;
      }
      for (const call of batch) {
        await this.records.delete(CALLS_COLLECTION, call.key);
      }
      if (uncounted.length === batch.length) {
        return true;
      }
    }
    return false;
  }

  /**
   * A month's totals, then its call records. In that order: a call record the
   * totals' previous write added was deleted before the totals were written
   * again, so every call record read here is either in `counted` or not in
   * the totals.
   */
  private async monthState(month: string): Promise<MonthState> {
    const record = await this.records.get<MonthUsageValue>(
      USAGE_COLLECTION,
      monthKey(month),
    );
    return {
      record,
      totals: monthUsage(record),
      counted: countedCalls(record),
      calls: await this.callRecords(month),
    };
  }

  /** A month's call records, in key order. */
  private async callRecords(
    month: string,
  ): Promise<PluginRecord<CallUsageValue>[]> {
    const prefix = `${month}:`;
    const calls: PluginRecord<CallUsageValue>[] = [];
    let after = prefix;
    for (;;) {
      const page = await this.records.list<CallUsageValue>(CALLS_COLLECTION, {
        after,
        limit: LIST_LIMIT,
      });
      const inMonth = page.filter((call) => call.key.startsWith(prefix));
      calls.push(...inMonth);
      const last = page.at(-1);
      if (
        last === undefined ||
        inMonth.length < page.length ||
        page.length < LIST_LIMIT
      ) {
        break;
      }
      after = last.key;
    }
    return calls;
  }
}

// The record types, written as JSON object types so the store accepts them.
type MonthUsageValue = { readonly [Field in keyof MonthUsage]: number } & {
  readonly counted: readonly string[];
};
type CallUsageValue = { readonly [Field in keyof ModelUsage]: number };
type RateWindowValue = { readonly minute: string; readonly count: number };

function monthKey(month: string): string {
  return `month:${month}`;
}

/** The month a call record is for, from its key `2026-10:<uuid>`. */
function callMonth(key: string): string | null {
  return /^\d{4}-\d{2}:/.test(key) ? key.slice(0, 7) : null;
}

/** A count as stored, or 0 for anything that is not one. */
function count(field: unknown): number {
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
    ? field
    : 0;
}

/**
 * A stored month, read field by field: a record the package did not write
 * the way it expects counts as nothing used, rather than failing every call.
 */
function monthUsage(record: PluginRecord<MonthUsageValue> | null): MonthUsage {
  if (record === null) {
    return NO_USAGE;
  }
  const value = record.value as Partial<Record<keyof MonthUsage, unknown>>;
  return {
    inputTokens: count(value.inputTokens),
    outputTokens: count(value.outputTokens),
    cacheReadTokens: count(value.cacheReadTokens),
    cacheWriteTokens: count(value.cacheWriteTokens),
    calls: count(value.calls),
  };
}

function countedCalls(
  record: PluginRecord<MonthUsageValue> | null,
): ReadonlySet<string> {
  const counted = (record?.value as { counted?: unknown } | undefined)?.counted;
  return new Set(
    Array.isArray(counted)
      ? counted.filter((key): key is string => typeof key === "string")
      : [],
  );
}

/** A month's totals with the call records they do not include. */
function monthTotal(state: MonthState): MonthUsage {
  return withCalls(
    state.totals,
    state.calls.filter((call) => !state.counted.has(call.key)),
  );
}

/** The totals with each call record's use added, read field by field. */
function withCalls(
  totals: MonthUsage,
  calls: readonly PluginRecord<CallUsageValue>[],
): MonthUsage {
  return calls.reduce<MonthUsage>((sum, call) => {
    const value = call.value as Partial<Record<keyof ModelUsage, unknown>>;
    return {
      inputTokens: sum.inputTokens + count(value.inputTokens),
      outputTokens: sum.outputTokens + count(value.outputTokens),
      cacheReadTokens: sum.cacheReadTokens + count(value.cacheReadTokens),
      cacheWriteTokens: sum.cacheWriteTokens + count(value.cacheWriteTokens),
      calls: sum.calls + 1,
    };
  }, totals);
}

function rateWindow(
  record: PluginRecord<RateWindowValue> | null,
): RateWindow | null {
  const value = record?.value as Partial<Record<string, unknown>> | undefined;
  if (
    typeof value?.minute !== "string" ||
    typeof value.count !== "number" ||
    !Number.isSafeInteger(value.count)
  ) {
    return null;
  }
  return { minute: value.minute, count: value.count };
}

const STOCKHOLM_MONTH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
});

/**
 * The calendar month in Stockholm, `YYYY-MM`: the month the association's
 * limit is for, whatever zone the server runs in.
 */
export function stockholmMonth(instant: Date): string {
  const parts = STOCKHOLM_MONTH.formatToParts(instant);
  const part = (type: string): string =>
    parts.find((each) => each.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}`;
}

function utcMinute(instant: Date): string {
  return instant.toISOString().slice(0, 16);
}

function secondsToNextMinute(instant: Date): number {
  return 60 - instant.getUTCSeconds();
}
