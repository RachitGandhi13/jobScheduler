export type RetryStrategy = "fixed" | "linear" | "exponential";

/**
 * `attempt` is the attempt number that just failed (1-indexed). Returns the
 * timestamp the job should become eligible for its next attempt.
 */
export function computeNextRunAt(
  strategy: RetryStrategy,
  baseDelayMs: number,
  attempt: number,
): Date {
  let delayMs: number;
  switch (strategy) {
    case "fixed":
      delayMs = baseDelayMs;
      break;
    case "linear":
      delayMs = baseDelayMs * attempt;
      break;
    case "exponential":
      delayMs = baseDelayMs * 2 ** (attempt - 1);
      break;
  }
  return new Date(Date.now() + delayMs);
}
