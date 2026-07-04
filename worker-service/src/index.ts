import "dotenv/config";
import { createDb } from "@scheduler/db";
import { markWorkerOffline, registerWorker, startHeartbeat } from "./heartbeat.js";
import { startJobAvailableListener } from "./listen.js";
import { runSweep } from "./sweep.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 1000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 5000);
const MAX_CLAIM_PER_QUEUE = Number(process.env.MAX_CLAIM_PER_QUEUE ?? 5);
// Which shard of a sharded queue this worker group is responsible for (see
// claim.ts). 0 is also the correct value for an entirely unsharded fleet.
const WORKER_SHARD_INDEX = Number(process.env.WORKER_SHARD_INDEX ?? 0);

export const db = createDb(DATABASE_URL);

let shuttingDown = false;
const inFlight = new Set<Promise<void>>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Lets a pg_notify('job_available', ...) short-circuit the current poll wait
// instead of the worker sitting out the rest of POLL_INTERVAL_MS. Racing
// against a notification rather than replacing the sleep entirely means a
// missed/dropped notification (LISTEN_DATABASE_URL unset, or a delivery that
// happens between polls) never leaves a job waiting longer than one normal
// poll interval -- this is purely additive to correctness, never a
// substitute for it.
let wake: (() => void) | null = null;
function waitForWakeOrTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

async function pollOnce(workerId: string) {
  const { inFlight: newlyClaimed } = await runSweep(db, workerId, {
    maxClaimPerQueue: MAX_CLAIM_PER_QUEUE,
    workerShardIndex: WORKER_SHARD_INDEX,
    onJobCrash: (jobId, err) => console.error(`[worker] job ${jobId} execution crashed unexpectedly`, err),
  });
  for (const task of newlyClaimed) inFlight.add(task);
}

async function pollLoop(workerId: string) {
  while (!shuttingDown) {
    try {
      await pollOnce(workerId);
    } catch (err) {
      console.error("[worker] poll cycle failed", err);
    }
    await waitForWakeOrTimeout(POLL_INTERVAL_MS);
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

  const stopListening = startJobAvailableListener(() => wake?.());

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, draining ${inFlight.size} in-flight job(s)...`);
    clearInterval(heartbeatTimer);
    wake?.();
    await stopListening?.();
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
