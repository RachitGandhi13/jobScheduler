import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { jobs } from "@scheduler/db";
import { claimJobs } from "../claim.js";
import { cleanupTestFixtures, createTestQueue, createTestWorkers } from "./fixtures.js";
import { getTestDb } from "./setup.js";

describe("claimJobs -- workflow dependency gating (parentJobId)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("never claims a job whose parent is not yet 'completed'", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const [worker] = await createTestWorkers(db, 1);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds: [worker!.id] });

    const [parent] = await db
      .insert(jobs)
      .values({ queueId: queue.id, type: "parent-task", status: "running", runAt: new Date() })
      .returning();

    const [child] = await db
      .insert(jobs)
      .values({ queueId: queue.id, type: "child-task", status: "queued", runAt: new Date(), parentJobId: parent!.id })
      .returning();

    // Parent is 'running', not 'completed' -- the child must stay out of the
    // candidate set entirely, not just be deprioritized behind the parent.
    const claimed = await claimJobs(db, queue.id, 10, worker!.id);
    expect(claimed.map((j) => j.id)).not.toContain(child!.id);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, child!.id));
    expect(row!.status).toBe("queued");
  });

  it("claims the dependent job once its parent is strictly 'completed'", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const [worker] = await createTestWorkers(db, 1);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds: [worker!.id] });

    const [parent] = await db
      .insert(jobs)
      .values({ queueId: queue.id, type: "parent-task", status: "completed", runAt: new Date() })
      .returning();

    const [child] = await db
      .insert(jobs)
      .values({ queueId: queue.id, type: "child-task", status: "queued", runAt: new Date(), parentJobId: parent!.id })
      .returning();

    const claimed = await claimJobs(db, queue.id, 10, worker!.id);
    expect(claimed.map((j) => j.id)).toContain(child!.id);
  });

  it("claims a job with no parentJobId exactly as before (unaffected by the dependency gate)", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const [worker] = await createTestWorkers(db, 1);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds: [worker!.id] });

    const [job] = await db
      .insert(jobs)
      .values({ queueId: queue.id, type: "standalone-task", status: "queued", runAt: new Date() })
      .returning();

    const claimed = await claimJobs(db, queue.id, 10, worker!.id);
    expect(claimed.map((j) => j.id)).toContain(job!.id);
  });
});
