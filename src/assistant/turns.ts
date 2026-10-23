import {
  isRecordConflict,
  type PluginRecord,
  type PluginRecords,
} from "../host-contract.ts";
import type { Proposal } from "./tool-loop.ts";

/**
 * Each turn, run once.
 *
 * The view names every turn with an id of its own and the time it first sent
 * it, and sends both again when it sends the turn again, after an answer that
 * never arrived. The first request with an id claims it in the package's
 * records (ADR 0033) before the model is called. A later one finds the claim
 * and runs nothing: it is told the changes the turn proposed, that the turn
 * is still running, or, once the receipt is gone, that the turn is over. So
 * a retried turn proposes nothing a second time.
 *
 * The request running a turn says it is alive in the record before each call
 * to the model and each change it proposes. A turn not heard from in ten
 * minutes died with its request, however long it has run: a later request
 * finishes its record, over the revision it read, and is told what it had
 * proposed. Should the request be only slow, it finds the record finished at
 * its next step and proposes nothing more. A turn is never taken for over
 * while it is still heard from, so a retry is told it runs until it has
 * proposed all it will.
 *
 * The record holds the pending changes' ids, actions, addresses and expiry,
 * and, while the turn runs, when it was last heard from. It holds nothing
 * anybody wrote: not the prompt, not the answer, not the input of a change.
 * Nor does it say whose turn it was. The pending changes are kept for an
 * hour, which is far longer than a retry waits. After that a later turn
 * empties the record, keeping only when the turn started, and deletes it
 * once it is two weeks old.
 *
 * A turn first sent more than a week before, or dated more than a week
 * ahead, is not run at all. So a record outlives every request that could
 * still claim its id, however far the person's clock is off within that
 * week, and a turn sent again after its record is gone is refused rather
 * than run twice.
 */

export const TURNS = "assistant-turns";

/** A turn's id, as the view mints one with `crypto.randomUUID()`. */
const TURN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A running turn not heard from for this long died with its request. Far
 * longer than one step of a turn: a call to the model, which times out after
 * five minutes at most, or a proposal.
 */
export const TURN_STALE_MS = 10 * 60_000;

/** How long a turn's pending changes are kept, to tell a retry. */
export const TURN_KEPT_MS = 60 * 60_000;

/** How far from now a turn may have been first sent and still run. */
export const TURN_ACCEPTED_MS = 7 * 24 * 60 * 60_000;

/**
 * How long a turn's emptied record is kept: long enough that a request
 * accepted by the rule above always finds it.
 */
export const TURN_REMEMBERED_MS = 2 * TURN_ACCEPTED_MS;

/** How many old turns one turn empties or deletes at most. */
const SWEEP_LIMIT = 50;

type TurnValue = {
  startedAt: string;
  /** While the turn runs, when its request last said it is alive. */
  aliveAt?: string;
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

/**
 * The time the view first sent a turn, as `Date.toISOString()` writes it, or
 * null when it is not one. A date that does not exist, such as 30 February,
 * would otherwise be read as one in the next month.
 */
export function sentAtOf(value: unknown): Date | null {
  if (typeof value !== "string" || value.length !== 24) {
    return null;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
    ? date
    : null;
}

export type TurnClaim =
  | { readonly kind: "claimed"; readonly turn: ClaimedTurn }
  | { readonly kind: "repeated"; readonly proposals: readonly Proposal[] }
  | { readonly kind: "in-progress" }
  | { readonly kind: "expired" };

/** A turn this request claimed, and writes its proposals to as they come. */
export class ClaimedTurn {
  /** Finished by another request, which took the turn for dead. */
  private givenUp = false;

  constructor(
    private readonly records: PluginRecords,
    private readonly id: string,
    private record: PluginRecord<TurnValue>,
    private readonly now: () => Date,
  ) {}

  /**
   * Says the turn is alive, before a step that may propose a change; false
   * once another request has taken it for dead, and then nothing more is
   * proposed.
   */
  async alive(): Promise<boolean> {
    return this.write({
      ...this.record.value,
      aliveAt: this.now().toISOString(),
    });
  }

  /**
   * Records a change the turn proposed. Lost only when the proposal took
   * longer than `TURN_STALE_MS` and the turn was taken for dead meanwhile; the
   * change waits on the pending changes screen all the same.
   */
  async proposed(proposal: Proposal): Promise<void> {
    await this.write({
      ...this.record.value,
      proposals: [...this.record.value.proposals, { ...proposal }],
    });
  }

  async finish(): Promise<void> {
    const { aliveAt: _alive, ...value } = this.record.value;
    await this.write({ ...value, finished: true });
  }

  /** False when another request finished the turn first. */
  private async write(value: TurnValue): Promise<boolean> {
    if (this.givenUp) {
      return false;
    }
    try {
      // Over the revision this request wrote: a conflict means another
      // request finished the turn since, taking it for dead.
      this.record = await this.records.put(TURNS, this.id, value, {
        expectedRevision: this.record.revision,
      });
      return true;
    } catch (error) {
      if (!isRecordConflict(error)) {
        throw error;
      }
      this.givenUp = true;
      return false;
    }
  }
}

export class Turns {
  constructor(
    private readonly records: PluginRecords,
    private readonly now: () => Date,
    /** Where a sweep starts among the keys. */
    private readonly from: () => string = () => crypto.randomUUID(),
  ) {}

  /** Claims the turn `id`, which the view first sent at `sentAt`. */
  async claim(id: string, sentAt: Date): Promise<TurnClaim> {
    const startedAt = this.now();
    if (Math.abs(startedAt.getTime() - sentAt.getTime()) > TURN_ACCEPTED_MS) {
      return { kind: "expired" };
    }
    await this.sweep();
    try {
      const record = await this.records.put<TurnValue>(
        TURNS,
        id,
        {
          startedAt: startedAt.toISOString(),
          aliveAt: startedAt.toISOString(),
          finished: false,
          proposals: [],
        },
        { expectedRevision: null },
      );
      return {
        kind: "claimed",
        turn: new ClaimedTurn(this.records, id, record, this.now),
      };
    } catch (error) {
      if (!isRecordConflict(error)) {
        throw error;
      }
    }

    const held = await this.records.get<TurnValue>(TURNS, id);
    if (held === null) {
      // Claimed and swept in between, two weeks on: the turn is long over.
      return { kind: "expired" };
    }
    const { value } = held;
    if (!value.finished) {
      if (isRunning(value, startedAt.getTime())) {
        return { kind: "in-progress" };
      }
      // Its request died. The record is finished over the revision read, so
      // that a request only slow finds it so and proposes nothing more.
      try {
        await this.records.put<TurnValue>(
          TURNS,
          id,
          {
            startedAt: value.startedAt,
            finished: true,
            proposals: value.proposals,
          },
          { expectedRevision: held.revision },
        );
      } catch (error) {
        if (!isRecordConflict(error)) {
          throw error;
        }
        // Heard from just now, or finished by another request: either way
        // the view sends the turn again.
        return { kind: "in-progress" };
      }
    }
    if (startedAt.getTime() - Date.parse(value.startedAt) >= TURN_KEPT_MS) {
      // Its pending changes are no longer kept, whether or not a sweep has
      // emptied the record yet.
      return { kind: "expired" };
    }
    // A turn whose request died is not run again either: it may have
    // proposed changes it never wrote down.
    return { kind: "repeated", proposals: value.proposals };
  }

  /**
   * Empties turns older than an hour and deletes those older than two weeks,
   * a few at a time, leaving alone a turn still running.
   *
   * From a random place among the keys, which are random themselves: the
   * first keys in order could otherwise all be recent ones, and an old turn
   * further on never be reached.
   */
  private async sweep(): Promise<void> {
    const now = this.now().getTime();
    const held = await this.records.list<TurnValue>(TURNS, {
      after: this.from(),
      limit: SWEEP_LIMIT,
    });
    for (const record of held) {
      const startedAt = Date.parse(record.value.startedAt);
      if (isRunning(record.value, now)) {
        continue;
      }
      try {
        if (startedAt < now - TURN_REMEMBERED_MS) {
          await this.records.delete(TURNS, record.key, {
            expectedRevision: record.revision,
          });
        } else if (
          startedAt < now - TURN_KEPT_MS &&
          (record.value.proposals.length > 0 || !record.value.finished)
        ) {
          await this.records.put<TurnValue>(
            TURNS,
            record.key,
            {
              startedAt: record.value.startedAt,
              finished: true,
              proposals: [],
            },
            { expectedRevision: record.revision },
          );
        }
      } catch (error) {
        // Another turn swept it first, or the turn wrote to it since.
        if (!isRecordConflict(error)) {
          throw error;
        }
      }
    }
  }
}

/** Whether a turn is still running: unfinished, and heard from lately. */
function isRunning(value: TurnValue, now: number): boolean {
  return (
    !value.finished &&
    now - Date.parse(value.aliveAt ?? value.startedAt) < TURN_STALE_MS
  );
}
