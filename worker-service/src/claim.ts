import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { jobs, queues, type Database } from "@scheduler/db";

/**
 * Atomically claims up to `limit` due jobs on a queue for this worker.
 *
 * SELECT ... FOR UPDATE SKIP LOCKED inside a transaction means concurrent
 * workers racing this same query never block on each other and never pick
 * the same row: a row already locked by another worker's in-flight
 * transaction is simply skipped, not waited on. The UPDATE that flips
 * status -> 'claimed' happens in the same transaction, so the row is
 * released (via commit) only once it is no longer visible as 'queued'.
 *
 * Joins queues and requires is_paused = false directly in this query (rather
 * than trusting the caller to have already filtered out paused queues) so a
 * pause that lands between the caller's queue lookup and this call still
 * takes effect immediately -- see DEVELOPMENT.md for the full trace.
 * 'scheduled' is included alongside 'queued' since delayed/recurring jobs are
 * created with that status and become claimable once run_at is due, with no
 * separate promotion step.
 */
export async function claimJobs(
  db: Database,
  queueId: string,
  limit: number,
  workerId: string,
) {
  if (limit <= 0) return [];

  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(queues, eq(jobs.queueId, queues.id))
      .where(
        and(
          eq(jobs.queueId, queueId),
          eq(queues.isPaused, false),
          inArray(jobs.status, ["queued", "scheduled"]),
          lte(jobs.runAt, sql`now()`),
        ),
      )
      .orderBy(desc(jobs.priority), asc(jobs.runAt))
      .limit(limit)
      .for("update", { skipLocked: true, of: jobs });

    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.id);

    return tx
      .update(jobs)
      .set({
        status: "claimed",
        claimedBy: workerId,
        claimedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(inArray(jobs.id, ids))
      .returning();
  });
}

/** Jobs currently claimed or running on a queue, used to respect its concurrencyLimit. */
export async function getInFlightCount(db: Database, queueId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.queueId, queueId), inArray(jobs.status, ["claimed", "running"])));
  return row?.count ?? 0;
}
