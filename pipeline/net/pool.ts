/**
 * Bounded concurrency plus per-host politeness. The current code fires every
 * feed and up to ~240 article fetches in parallel with no cap; this replaces it.
 */

export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (!run) return;
    active++;
    run();
  };

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

/** Serializes per host and enforces a minimum gap between requests to it. */
export function createHostGate(defaultDelayMs = 250) {
  const chains = new Map<string, Promise<void>>();

  return function gate<T>(host: string, delayMs: number, task: () => Promise<T>): Promise<T> {
    const wait = Math.max(0, delayMs || defaultDelayMs);
    const previous = chains.get(host) ?? Promise.resolve();
    const result = previous.then(task);
    chains.set(
      host,
      result.then(
        () => sleep(wait),
        () => sleep(wait),
      ),
    );
    return result;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
