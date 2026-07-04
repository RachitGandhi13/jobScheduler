import { sql } from "drizzle-orm";
import { db } from "../db.js";

const JOB_AVAILABLE_CHANNEL = "job_available";

/**
 * Publishes a Postgres NOTIFY so a listening worker-service instance (see
 * worker-service/src/listen.ts) wakes up and claims immediately instead of
 * waiting for its next POLL_INTERVAL_MS tick. Payload is just the queueId --
 * the listener still re-runs its own claim query rather than trusting the
 * notification body, so this is purely a latency optimization: a worker that
 * never received the notification (not running, or NOTIFY dropped because no
 * one was listening at the moment) still picks the job up on its next poll.
 * A notify failure here must never fail the request that created the job --
 * polling is the correctness guarantee, this is only ever a speedup.
 */
export async function notifyJobAvailable(queueId: string): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_notify(${JOB_AVAILABLE_CHANNEL}, ${queueId})`);
  } catch {
    // Best-effort. Swallowed deliberately -- see the comment above.
  }
}

export { JOB_AVAILABLE_CHANNEL };
