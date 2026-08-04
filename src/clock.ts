/**
 * Injectable time.
 *
 * Everything time-dependent in this server — cache TTLs, the token-bucket
 * limiter — takes a `Clock` rather than calling `Date.now()` or `setTimeout`
 * directly. That is what makes §8's determinism requirement achievable: a test
 * can assert that arXiv requests are spaced 3 seconds apart without the suite
 * actually taking 3 seconds, and without the result depending on how loaded
 * the machine was.
 */

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolve after `ms` of this clock's time has passed. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

interface PendingSleep {
  at: number;
  resolve: () => void;
}

/**
 * A clock that only moves when a test moves it.
 *
 * `advance()` fires pending sleeps in timestamp order, setting `now` to each
 * sleep's own deadline before resolving it. Waking a sleeper at the time it
 * asked for — rather than at the end of the whole advance — is what lets a
 * test advance 10s in one call and still observe four separate 3s arXiv slots
 * rather than four simultaneous ones.
 */
export class FakeClock implements Clock {
  #now: number;
  #pending: PendingSleep[] = [];

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#pending.push({ at: this.#now + ms, resolve });
    });
  }

  /** Number of sleepers currently waiting. Useful for asserting a caller blocked. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /**
   * Move time forward by `ms`, waking sleepers as their deadlines pass.
   *
   * Awaits a macrotask turn after each wake so the resumed code can run and
   * register its next sleep before time moves again — without that, a loop
   * that sleeps repeatedly would only get one iteration per `advance()` call.
   */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;

    for (;;) {
      let nextIndex = -1;
      let nextAt = Infinity;
      for (let i = 0; i < this.#pending.length; i += 1) {
        const pending = this.#pending[i];
        if (pending !== undefined && pending.at <= target && pending.at < nextAt) {
          nextAt = pending.at;
          nextIndex = i;
        }
      }
      if (nextIndex === -1) break;

      const [due] = this.#pending.splice(nextIndex, 1);
      this.#now = nextAt;
      due?.resolve();
      await drainTasks();
    }

    this.#now = target;
    await drainTasks();
  }
}

/**
 * Let queued promise callbacks run. `setImmediate` is real time, but it is
 * only used here to yield the event loop — the clock the code under test reads
 * is still entirely controlled by `advance()`.
 */
function drainTasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
