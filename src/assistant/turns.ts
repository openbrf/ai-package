import {
  isRecordConflict,
  type PluginRecord,
  type PluginRecords,
} from "../host-contract.ts";
import type { Proposal } from "./tool-loop.ts";

/**
 * Each turn, run once.
 *
 * The view names every turn with an id of its own and sends the same id when
 * it sends the turn again, after an answer that never arrived. The first
 * request with an id claims it in the package's records (ADR 0033) before the
 * model is called. A later one finds the claim and runs nothing: it is told
 * the changes the turn proposed, or that the turn is still running. So a
 * retried turn proposes nothing a second time.
 *
 * The record holds the pending changes' ids, actions, addresses and expiry,
 * and nothing anybody wrote: not the prompt, not the answer, not the input of
 * a change. Nor does it say whose turn it was. It is kept for an hour, which
 * is far longer than a retry waits and far shorter than a pending change's
 * week, and deleted by a later turn after that.
 */

export const TURNS = "assistant-turns";

/** A turn's id, as the view mints one with `crypto.randomUUID()`. */
const TURN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A turn not finished by then died with its request. */
export const TURN_STALE_MS = 10 * 60_000;

/** How long a turn's record is kept. */
export const TURN_KEPT_MS = 60 * 60_000;

/** How many old turns one turn deletes at most. */
const SWEEP_LIMIT = 50;

type TurnValue = {
  startedAt: string;
  finished: boolean;
  proposals: {
    id: string;
    action: string;
    title: string;
    path: string;
    expiresAt: string;
  }[];
};

export function isTurnId(value: unknown): value is string {
  return typeof value === "string" && TURN_ID.test(value);
}

export type TurnClaim =
  | { readonly kind: "claimed"; readonly turn: ClaimedTurn }
  | { readonly kind: "repeated"; readonly proposals: readonly Proposal[] }
  | { readonly kind: "in-progress" };

/** A turn this request claimed, and writes its proposals to as they come. */
export class ClaimedTurn {
  constructor(
    private readonly records: PluginRecords,
    private readonly id: string,
    private record: PluginRecord<TurnValue>,
  ) {}

  async proposed(proposal: Proposal): Promise<void> {
    await this.write({
      ...this.record.value,
      proposals: [...this.record.value.proposals, { ...proposal }],
    });
  }

  async finish(): Promise<void> {
    await this.write({ ...this.record.value, finished: true });
  }

  private async write(value: TurnValue): Promise<void> {
    // Over the revision this request wrote: nothing else writes a claimed
    // turn, so a conflict here is a fault and is thrown.
    this.record = await this.records.put(TURNS, this.id, value, {
      expectedRevision: this.record.revision,
    });
  }
}

export class Turns {
  constructor(
    private readonly records: PluginRecords,
    private readonly now: () => Date,
    /** Where a sweep starts among the keys. */
    private readonly from: () => string = () => crypto.randomUUID(),
  ) {}

  async claim(id: string): Promise<TurnClaim> {
    await this.sweep();
    const startedAt = this.now();
    try {
      const record = await this.records.put<TurnValue>(
        TURNS,
        id,
        { startedAt: startedAt.toISOString(), finished: false, proposals: [] },
        { expectedRevision: null },
      );
      return {
        kind: "claimed",
        turn: new ClaimedTurn(this.records, id, record),
      };
    } catch (error) {
      if (!isRecordConflict(error)) {
        throw error;
      }
    }

    const held = await this.records.get<TurnValue>(TURNS, id);
    if (held === null) {
      // Claimed and swept in between, an hour on: the turn is long over.
      return { kind: "repeated", proposals: [] };
    }
    const { value } = held;
    const stale =
      startedAt.getTime() - Date.parse(value.startedAt) >= TURN_STALE_MS;
    if (!value.finished && !stale) {
      return { kind: "in-progress" };
    }
    // A turn whose request died is not run again either: it may have
    // proposed changes it never wrote down.
    return { kind: "repeated", proposals: value.proposals };
  }

  /**
   * Deletes turns older than an hour, a few at a time.
   *
   * From a random place among the keys, which are random themselves: the
   * first keys in order could otherwise all be recent ones, and an old turn
   * further on never be reached.
   */
  private async sweep(): Promise<void> {
    const cutoff = this.now().getTime() - TURN_KEPT_MS;
    const held = await this.records.list<TurnValue>(TURNS, {
      after: this.from(),
      limit: SWEEP_LIMIT,
    });
    for (const record of held) {
      if (Date.parse(record.value.startedAt) < cutoff) {
        try {
          await this.records.delete(TURNS, record.key, {
            expectedRevision: record.revision,
          });
        } catch (error) {
          // Another turn swept it first.
          if (!isRecordConflict(error)) {
            throw error;
          }
        }
      }
    }
  }
}
