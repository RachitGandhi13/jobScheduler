import "dotenv/config";
import { createDb } from "@scheduler/db";
import { markWorkerOffline, registerWorker, startHeartbeat } from "./heartbeat.js";
import { runSweep } from "./sweep.js";

/**
 * One-shot entrypoint for running worker-service as a scheduled task (e.g.
 * Render Cron Job's free tier) instead of a continuously-running Background
 * Worker (Render's cheapest paid tier, $7/mo minimum). Registers a worker,
 * repeatedly sweeps every active queue until a pass claims nothing or a time
 * budget runs out, drains whatever it claimed, marks itself offline, exits.
 *
 * Trade-off vs. the continuous loop in index.ts: job pickup latency becomes
 * "up to however often the schedule fires" instead of ~POLL_INTERVAL_MS.
 * Looping sweeps within one invocation (rather than a single pass) matters
 * because a schedule firing every few minutes can find several minutes'
 * worth of due jobs backed up, not just whatever arrived since the last tick.
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const MAX_CLAIM_PER_QUEUE = Number(process.env.MAX_CLAIM_PER_QUEUE ?? 5);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 5000);
// Wall-clock budget for this invocation, so a busy sweep never runs past the
// next scheduled tick. Default assumes a schedule firing every 1-5 minutes.
const MAX_RUN_MS = Number(process.env.MAX_RUN_MS ?? 45_000);
// Sharding applies here too (unlike the LISTEN/NOTIFY optimization, which is
// continuous-loop only) -- a GitHub Actions matrix could run several
// one-shot invocations in parallel, each pinned to a different shard.
const WORKER_SHARD_INDEX = Number(process.env.WORKER_SHARD_INDEX ?? 0);

const db = createDb(DATABASE_URL);

async function main() {
  const workerId = await registerWorker(db);
  console.log(`[worker:once] registered as ${workerId} (pid ${process.pid})`);

  const heartbeatTimer = startHeartbeat(db, workerId, () => "busy", HEARTBEAT_INTERVAL_MS);
  const deadline = Date.now() + MAX_RUN_MS;

  let totalClaimed = 0;
  for (;;) {
    const { claimedCount, inFlight } = await runSweep(db, workerId, {
      maxClaimPerQueue: MAX_CLAIM_PER_QUEUE,
      workerShardIndex: WORKER_SHARD_INDEX,
      onJobCrash: (jobId, err) => console.error(`[worker:once] job ${jobId} execution crashed unexpectedly`, err),
    });
    await Promise.allSettled([...inFlight]);
    totalClaimed += claimedCount;

    if (claimedCount === 0 || Date.now() > deadline) break;
  }

  clearInterval(heartbeatTimer);
  await markWorkerOffline(db, workerId);
  console.log(`[worker:once] done, claimed ${totalClaimed} job(s) this run`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker:once] fatal error", err);
  process.exit(1);
});
