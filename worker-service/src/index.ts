import "dotenv/config";
import { eq } from "drizzle-orm";
import { createDb, queues as queuesTable } from "@scheduler/db";
import { claimJobs, getInFlightCount } from "./claim.js";
import { executeClaimedJob } from "./execute.js";
import { markWorkerOffline, registerWorker, startHeartbeat } from "./heartbeat.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 5000);
const MAX_CLAIM_PER_QUEUE = Number(process.env.MAX_CLAIM_PER_QUEUE ?? 5);

export const db = createDb(DATABASE_URL);

let shuttingDown = false;
const inFlight = new Set<Promise<void>>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollOnce(workerId: string) {
  const activeQueues = await db.select().from(queuesTable).where(eq(queuesTable.isPaused, false));

  for (const queue of activeQueues) {
    if (shuttingDown) break;

    // Respect the queue's concurrencyLimit across the whole fleet, not just this
    // worker: in-flight count is a DB read, so it reflects every worker's claims.
    const currentInFlight = await getInFlightCount(db, queue.id);
    const availableSlots = queue.concurrencyLimit - currentInFlight;
    if (availableSlots <= 0) continue;

    const claimLimit = Math.min(availableSlots, MAX_CLAIM_PER_QUEUE);
    const claimed = await claimJobs(db, queue.id, claimLimit, workerId);

    for (const job of claimed) {
      const task = executeClaimedJob(db, job, queue, workerId).catch((err) =>
        console.error(`[worker] job ${job.id} execution crashed unexpectedly`, err),
      );
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    }
  }
}

async function pollLoop(workerId: string) {
  while (!shuttingDown) {
    try {
      await pollOnce(workerId);
    } catch (err) {
      console.error("[worker] poll cycle failed", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function main() {
  const workerId = await registerWorker(db);
  console.log(`[worker] registered as ${workerId} (pid ${process.pid}, host ${process.env.HOSTNAME ?? ""})`);

  const heartbeatTimer = startHeartbeat(
    db,
    workerId,
    () => (inFlight.size > 0 ? "busy" : "idle"),
    HEARTBEAT_INTERVAL_MS,
  );

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, draining ${inFlight.size} in-flight job(s)...`);
    clearInterval(heartbeatTimer);
    await Promise.allSettled([...inFlight]);
    await markWorkerOffline(db, workerId);
    console.log("[worker] shut down cleanly");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await pollLoop(workerId);
}

main().catch((err) => {
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
