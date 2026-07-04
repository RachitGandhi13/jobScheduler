import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { jobs, queues, type Database } from "@scheduler/db";

// Self-join alias: reads the parent job's status without locking it -- only
// the child row (aliased as `jobs` itself below) is the FOR UPDATE target.
const parentJobs = alias(jobs, "parent_jobs");

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
 *
 * `workerShardIndex` implements queue sharding: each job's shard_key (a fixed
 * hash of its id, see packages/db/src/shard.ts) is reduced modulo the queue's
 * own shardCount, and only rows landing on this worker's shard are even
 * candidates. A queue with shardCount=1 (the default) always resolves every
 * job to shard 0, so a fleet running the default workerShardIndex=0 sees
 * unsharded behavior identical to before this existed. Splitting a hot
 * queue's shardCount across N worker groups (each pinned to a different
 * WORKER_SHARD_INDEX) means those groups' claim queries never scan or
 * SKIP LOCKED over each other's rows at all, instead of merely not blocking
 * on them.
 */
export async function claimJobs(
  db: Database,
  queueId: string,
  limit: number,
  workerId: string,
  workerShardIndex = 0,
) {
  if (limit <= 0) return [];

  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(queues, eq(jobs.queueId, queues.id))
      .leftJoin(parentJobs, eq(jobs.parentJobId, parentJobs.id))
      .where(
        and(
          eq(jobs.queueId, queueId),
          eq(queues.isPaused, false),
          inArray(jobs.status, ["queued", "scheduled"]),
          lte(jobs.runAt, sql`now()`),
          // Workflow dependency gate: a job with no parent is always eligible;
          // one with a parent stays out of the candidate set (not just
          // deprioritized) until that parent is strictly 'completed'.
          or(isNull(jobs.parentJobId), eq(parentJobs.status, "completed")),
          // Sharding gate: skip rows that don't belong to this worker's shard.
          eq(sql`${jobs.shardKey} % ${queues.shardCount}`, workerShardIndex),
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
