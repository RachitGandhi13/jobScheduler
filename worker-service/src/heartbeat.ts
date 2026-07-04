import os from "node:os";
import { eq } from "drizzle-orm";
import { workerHeartbeats, workers, type Database } from "@scheduler/db";

export async function registerWorker(db: Database): Promise<string> {
  const now = new Date();
  const [worker] = await db
    .insert(workers)
    .values({ hostname: os.hostname(), pid: process.pid, status: "idle", startedAt: now })
    .returning();

  await db.insert(workerHeartbeats).values({ workerId: worker.id, status: "idle", heartbeatAt: now });

  return worker.id;
}

/**
 * Every `intervalMs`, updates this worker's current status and inserts a new
 * worker_heartbeats row -- an insert-only history log rather than overwriting
 * a single column, so "how healthy has this worker been" is a real queryable
 * log the backend-api zombie-cleanup monitor (and any dashboard) can read,
 * not just the latest snapshot.
 */
export function startHeartbeat(
  db: Database,
  workerId: string,
  getStatus: () => "idle" | "busy",
  intervalMs: number,
): NodeJS.Timeout {
  return setInterval(() => {
    const status = getStatus();
    const heartbeatAt = new Date();
    db.transaction(async (tx) => {
      await tx.update(workers).set({ status }).where(eq(workers.id, workerId));
      await tx.insert(workerHeartbeats).values({ workerId, status, heartbeatAt });
    }).catch((err) => console.error("[heartbeat] update failed", err));
  }, intervalMs);
}

export async function markWorkerOffline(db: Database, workerId: string): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(workers).set({ status: "offline" }).where(eq(workers.id, workerId));
    await tx.insert(workerHeartbeats).values({ workerId, status: "offline", heartbeatAt: now });
  });
}
