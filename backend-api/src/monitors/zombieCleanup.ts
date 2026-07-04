import { and, inArray, ne, sql } from "drizzle-orm";
import { jobLogs, jobs, workers, type Database } from "@scheduler/db";

const HEARTBEAT_TIMEOUT_MS = Number(process.env.WORKER_HEARTBEAT_TIMEOUT_MS ?? 15_000);

/**
 * A worker that stops sending heartbeats (crash, OOM kill, lost network) leaves
 * its claimed/running jobs stuck forever unless something else notices. This
 * sweep marks workers whose *most recent* heartbeat (worker_heartbeats is an
 * insert-only history log, not a single overwritten column -- see schema.ts)
 * is older than the timeout as 'offline' and requeues whatever they were
 * holding — immediately eligible (run_at = now) and with attempts left
 * untouched, since this is an infrastructure failure, not a job failure.
 */
export async function runZombieCleanup(db: Database): Promise<void> {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);

  // Plain grouped raw query rather than joining a raw-SQL-aliased subquery
  // back into a typed drizzle comparison -- the latter hit a postgres.js
  // parameter-binding bug (Date vs string) comparing against a max(...)
  // derived column. At this project's worker-fleet scale, a second
  // round-trip plus a JS filter is simpler and more robust than chasing that
  // typing through drizzle's subquery API.
  const latestHeartbeats = await db.execute<{ worker_id: string; latest_at: Date }>(
    sql`SELECT worker_id, MAX(heartbeat_at) AS latest_at FROM worker_heartbeats GROUP BY worker_id`,
  );

  // A worker with zero heartbeat rows (crashed before its first tick) is
  // intentionally not caught here -- it never claimed anything either, so
  // there's nothing to reclaim.
  const candidateIds = latestHeartbeats
    .filter((row) => new Date(row.latest_at).getTime() < cutoff.getTime())
    .map((row) => row.worker_id);

  if (candidateIds.length === 0) return;

  const staleWorkers = await db
    .update(workers)
    .set({ status: "offline" })
    .where(and(inArray(workers.id, candidateIds), ne(workers.status, "offline")))
    .returning({ id: workers.id });

  if (staleWorkers.length === 0) return;

  const staleWorkerIds = staleWorkers.map((w) => w.id);

  const orphanedJobs = await db
    .update(jobs)
    .set({
      status: "queued",
      claimedBy: null,
      claimedAt: null,
      runAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(inArray(jobs.status, ["claimed", "running"]), inArray(jobs.claimedBy, staleWorkerIds)))
    .returning({ id: jobs.id });

  if (orphanedJobs.length > 0) {
    await db.insert(jobLogs).values(
      orphanedJobs.map((job) => ({
        jobId: job.id,
        level: "warn" as const,
        message: "Requeued: claiming worker missed its heartbeat and was marked offline",
      })),
    );
  }

  console.warn(
    `[zombie-cleanup] marked ${staleWorkerIds.length} worker(s) offline, requeued ${orphanedJobs.length} job(s)`,
  );
}

export function startZombieCleanup(db: Database, intervalMs = 10_000): NodeJS.Timeout {
  return setInterval(() => {
    runZombieCleanup(db).catch((err) => console.error("[zombie-cleanup] sweep failed", err));
  }, intervalMs);
}
