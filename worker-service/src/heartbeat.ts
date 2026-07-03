import os from "node:os";
import { eq } from "drizzle-orm";
import { workers, type Database } from "@scheduler/db";

export async function registerWorker(db: Database): Promise<string> {
  const now = new Date();
  const [worker] = await db
    .insert(workers)
    .values({ hostname: os.hostname(), pid: process.pid, status: "idle", startedAt: now, lastHeartbeatAt: now })
    .returning();
  return worker.id;
}

/**
 * Updates this worker's row every `intervalMs` so the backend-api zombie
 * cleanup monitor can tell a live worker from a crashed one by heartbeat age.
 */
export function startHeartbeat(
  db: Database,
  workerId: string,
  getStatus: () => "idle" | "busy",
  intervalMs: number,
): NodeJS.Timeout {
  return setInterval(() => {
    db.update(workers)
      .set({ status: getStatus(), lastHeartbeatAt: new Date() })
      .where(eq(workers.id, workerId))
      .catch((err) => console.error("[heartbeat] update failed", err));
  }, intervalMs);
}

export async function markWorkerOffline(db: Database, workerId: string): Promise<void> {
  await db.update(workers).set({ status: "offline", lastHeartbeatAt: new Date() }).where(eq(workers.id, workerId));
}
