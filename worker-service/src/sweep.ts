import { eq } from "drizzle-orm";
import { queues as queuesTable, type Database } from "@scheduler/db";
import { claimJobs, getInFlightCount } from "./claim.js";
import { executeClaimedJob } from "./execute.js";

export interface SweepOptions {
  maxClaimPerQueue: number;
  onJobCrash?: (jobId: string, err: unknown) => void;
}

export interface SweepResult {
  claimedCount: number;
  inFlight: Set<Promise<void>>;
}

/**
 * One full pass over every active queue: claims up to `maxClaimPerQueue` due
 * jobs per queue (respecting concurrencyLimit fleet-wide) and kicks off
 * execution for each. Returns the in-flight execution promises so the caller
 * decides whether to wait for them (a single cron invocation) or let them run
 * alongside the next poll tick (the continuous loop).
 */
export async function runSweep(
  db: Database,
  workerId: string,
  { maxClaimPerQueue, onJobCrash }: SweepOptions,
): Promise<SweepResult> {
  const inFlight = new Set<Promise<void>>();
  let claimedCount = 0;

  const activeQueues = await db.select().from(queuesTable).where(eq(queuesTable.isPaused, false));

  for (const queue of activeQueues) {
    const currentInFlight = await getInFlightCount(db, queue.id);
    const availableSlots = queue.concurrencyLimit - currentInFlight;
    if (availableSlots <= 0) continue;

    const claimLimit = Math.min(availableSlots, maxClaimPerQueue);
    const claimed = await claimJobs(db, queue.id, claimLimit, workerId);
    claimedCount += claimed.length;

    for (const job of claimed) {
      const task = executeClaimedJob(db, job, queue, workerId).catch((err) => {
        onJobCrash?.(job.id, err);
      });
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    }
  }

  return { claimedCount, inFlight };
}
