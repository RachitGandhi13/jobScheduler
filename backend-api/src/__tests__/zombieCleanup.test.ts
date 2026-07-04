import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { jobs, workerHeartbeats, workers } from "@scheduler/db";
import { runZombieCleanup } from "../monitors/zombieCleanup.js";
import { cleanupTestFixtures, createTestQueue } from "./fixtures.js";
import { getTestDb } from "./setup.js";

describe("runZombieCleanup -- crashed worker recovery", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("reverts a running job to queued with attempts preserved, once its worker's heartbeat goes stale", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const [worker] = await db.insert(workers).values({ hostname: "test", status: "busy" }).returning();
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds: [worker.id] });

    // Default HEARTBEAT_TIMEOUT_MS is 15s; a heartbeat from a minute ago is
    // comfortably stale under that without needing to override the env var
    // (which zombieCleanup.ts reads once at module-load time anyway, so
    // setting it from inside a test wouldn't take effect).
    await db.insert(workerHeartbeats).values({
      workerId: worker.id,
      status: "busy",
      heartbeatAt: new Date(Date.now() - 60_000),
    });

    const [job] = await db
      .insert(jobs)
      .values({
        queueId: queue.id,
        type: "zombie-test",
        status: "running",
        claimedBy: worker.id,
        claimedAt: new Date(),
        startedAt: new Date(),
        attempts: 1, // already on a retry when the worker died
        runAt: new Date(),
      })
      .returning();

    await runZombieCleanup(db);

    const [afterSweep] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(afterSweep!.status).toBe("queued");
    expect(afterSweep!.claimedBy).toBeNull();
    expect(afterSweep!.attempts).toBe(1); // preserved -- this is an infra failure, not a job failure

    const [workerAfter] = await db.select().from(workers).where(eq(workers.id, worker.id));
    expect(workerAfter!.status).toBe("offline");
  });

  it("leaves a worker with a fresh heartbeat untouched", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const [worker] = await db.insert(workers).values({ hostname: "test", status: "busy" }).returning();
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds: [worker.id] });

    await db.insert(workerHeartbeats).values({ workerId: worker.id, status: "busy", heartbeatAt: new Date() });

    const [job] = await db
      .insert(jobs)
      .values({
        queueId: queue.id,
        type: "healthy-worker-test",
        status: "running",
        claimedBy: worker.id,
        claimedAt: new Date(),
        startedAt: new Date(),
        runAt: new Date(),
      })
      .returning();

    await runZombieCleanup(db);

    const [afterSweep] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(afterSweep!.status).toBe("running"); // untouched
    expect(afterSweep!.claimedBy).toBe(worker.id);

    const [workerAfter] = await db.select().from(workers).where(eq(workers.id, worker.id));
    expect(workerAfter!.status).toBe("busy"); // untouched
  });
});
