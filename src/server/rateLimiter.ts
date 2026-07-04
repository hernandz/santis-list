const DEFAULT_DELAY_MS = 3000;

let queue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes all Craigslist requests app-wide with a fixed delay between them,
 * so concurrent crawl/detail-fetch calls never hammer CL in parallel.
 */
export function withRateLimit<T>(fn: () => Promise<T>, delayMs = DEFAULT_DELAY_MS): Promise<T> {
  const result = queue.then(() => fn());
  queue = result.then(
    () => sleep(delayMs),
    () => sleep(delayMs),
  );
  return result;
}
