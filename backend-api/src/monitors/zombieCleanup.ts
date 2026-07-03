import { and, inArray, lt, ne } from "drizzle-orm";
import { jobLogs, jobs, workers, type Database } from "@scheduler/db";

const HEARTBEAT_TIMEOUT_MS = Number(process.env.WORKER_HEARTBEAT_TIMEOUT_MS ?? 15_000);

/**
 * A worker that stops sending heartbeats (crash, OOM kill, lost network) leaves
 * its claimed/running jobs stuck forever unless something else notices. This
 * sweep marks workers whose last heartbeat is older than the timeout as
 * 'offline' and requeues whatever they were holding — immediately eligible
 * (run_at = now) and with attempts left untouched, since this is an
 * infrastructure failure, not a job failure.
 */
export async function runZombieCleanup(db: Database): Promise<void> {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);

  const staleWorkers = await db
    .update(workers)
    .set({ status: "offline" })
    .where(and(ne(workers.status, "offline"), lt(workers.lastHeartbeatAt, cutoff)))
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
