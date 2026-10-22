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
 * person: a month's totals and the current minute's count, never who asked
 * or what for.
 *
 * Two writers can read the same revision. Each write is made over the
 * revision it read and tried again on a conflict, so no call is lost from a
 * count. The monthly limit is checked before a call, and a call already
 * under way is let finish, so a month can end over its limit by what the
 * calls under way at that moment used; the per-minute limit bounds how many
 * those are.
 */

export const USAGE_COLLECTION = "usage";

const RATE_KEY = "rate";

/** How often a write is tried again after losing to another writer. */
const ATTEMPTS = 8;

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

export class UsageMeter {
  constructor(
    private readonly records: PluginRecords,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** This month's totals, and which month it is. */
  async thisMonth(): Promise<{ month: string; usage: MonthUsage }> {
    const month = stockholmMonth(this.now());
    const record = await this.records.get<MonthUsageValue>(
      USAGE_COLLECTION,
      monthKey(month),
    );
    return { month, usage: monthUsage(record) };
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

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
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
    // Every attempt lost to another caller: the instance is as busy as the
    // limit allows, so this one waits.
    return { admitted: false, reason: "rate-limited", retryAfterSeconds: 1 };
  }

  /**
   * Adds what a call used to this month's totals. False when every attempt
   * lost to another writer, and the call went uncounted.
   */
  async record(used: ModelUsage): Promise<boolean> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const key = monthKey(stockholmMonth(this.now()));
      const record = await this.records.get<MonthUsageValue>(
        USAGE_COLLECTION,
        key,
      );
      const usage = monthUsage(record);
      try {
        await this.records.put<MonthUsageValue>(
          USAGE_COLLECTION,
          key,
          {
            inputTokens: usage.inputTokens + used.inputTokens,
            outputTokens: usage.outputTokens + used.outputTokens,
            cacheReadTokens: usage.cacheReadTokens + used.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens + used.cacheWriteTokens,
            calls: usage.calls + 1,
          },
          { expectedRevision: record?.revision ?? null },
        );
        return true;
      } catch (error) {
        if (!isRecordConflict(error)) {
          throw error;
        }
      }
    }
    return false;
  }
}

// The record types, written as JSON object types so the store accepts them.
type MonthUsageValue = { readonly [Field in keyof MonthUsage]: number };
type RateWindowValue = { readonly minute: string; readonly count: number };

function monthKey(month: string): string {
  return `month:${month}`;
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
  const count = (field: unknown): number =>
    typeof field === "number" && Number.isSafeInteger(field) && field >= 0
      ? field
      : 0;
  return {
    inputTokens: count(value.inputTokens),
    outputTokens: count(value.outputTokens),
    cacheReadTokens: count(value.cacheReadTokens),
    cacheWriteTokens: count(value.cacheWriteTokens),
    calls: count(value.calls),
  };
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
