/** The outcome of probing a dependency this service cannot run without. */
export type DependencyHealth =
  { status: 'up'; latencyMs: number } | { status: 'down'; error: string };

/**
 * The outcome of probing a dependency that can be switched off — RabbitMQ,
 * via `RABBITMQ_ENABLED=false`.
 *
 * A separate type rather than a third member of `DependencyHealth`, so a probe
 * that can never be disabled cannot claim to be: the database check returns the
 * narrower type, and the health DTO documents each one honestly.
 */
export type OptionalDependencyHealth =
  DependencyHealth | { status: 'disabled' };

/**
 * Bounds how long a health check may take.
 *
 * A dependency probe against a half-open socket can hang well past any
 * sensible request timeout — TCP alone can take minutes to notice the other
 * side is gone. A health endpoint that hangs is worse than one that answers
 * quickly and says "down": the first breaks whatever is polling it too, the
 * second doesn't.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // Forwarded as-is when it already is one; a caller that rejected with a
        // string or something else gets wrapped rather than silently coerced.
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
