import postgres from "postgres";

const JOB_AVAILABLE_CHANNEL = "job_available";

/**
 * Subscribes to backend-api's pg_notify('job_available', ...) so the
 * continuous poll loop (index.ts) can wake up the instant a job is enqueued,
 * instead of waiting out POLL_INTERVAL_MS. Deliberately opt-in via a
 * *separate* connection string (LISTEN_DATABASE_URL): Postgres LISTEN/NOTIFY
 * needs a persistent session-level connection, which a PgBouncer
 * transaction-pooling connection string -- what DATABASE_URL is, for Neon's
 * `-pooler` host, everywhere else in this project -- does not reliably
 * provide (a notification can be delivered to whichever backend the pooler
 * happens to hand out next, or not forwarded at all). LISTEN_DATABASE_URL
 * should point at Neon's *direct* (non-pooled) connection string instead.
 *
 * If LISTEN_DATABASE_URL is unset, this is a deliberate no-op: the worker
 * still functions correctly on polling alone (see notify.ts on the
 * backend-api side) -- this is purely a latency optimization, never a
 * correctness requirement, so an unconfigured deployment loses nothing but
 * some milliseconds of pickup latency on immediate jobs.
 */
export function startJobAvailableListener(onNotify: () => void): (() => Promise<void>) | null {
  const connectionString = process.env.LISTEN_DATABASE_URL;
  if (!connectionString) {
    console.log("[worker] LISTEN_DATABASE_URL not set -- event-driven wake-up disabled, polling only");
    return null;
  }

  const sql = postgres(connectionString, { prepare: false, max: 1 });

  sql
    .listen(JOB_AVAILABLE_CHANNEL, () => onNotify())
    .then(() => console.log(`[worker] listening on Postgres channel "${JOB_AVAILABLE_CHANNEL}"`))
    .catch((err) => console.error("[worker] failed to start LISTEN -- falling back to polling only", err));

  return () => sql.end({ timeout: 5 });
}
