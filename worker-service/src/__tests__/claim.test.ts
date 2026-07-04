import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { jobs } from "@scheduler/db";
import { claimJobs } from "../claim.js";
import { cleanupTestFixtures, createTestQueue, createTestWorkers } from "./fixtures.js";
import { getTestDb } from "./setup.js";

describe("claimJobs -- atomic claiming under a real concurrent race", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("exactly one of several concurrent claim attempts wins a single queued job", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const testWorkers = await createTestWorkers(db, 5);
    const workerIds = testWorkers.map((w) => w.id);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds });

    const [job] = await db
      .insert(jobs)
      .values({ queueId: queue.id, type: "race-test", status: "queued", runAt: new Date() })
      .returning();

    // 5 "workers" racing the exact same claim query against the exact same
    // due row at the same instant -- this is what FOR UPDATE SKIP LOCKED has
    // to get right: no two of these may ever see the job as theirs.
    const results = await Promise.all(workerIds.map((workerId) => claimJobs(db, queue.id, 1, workerId)));

    const winners = results.filter((claimed) => claimed.length === 1);
    const losers = results.filter((claimed) => claimed.length === 0);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    expect(winners[0]![0]!.id).toBe(job.id);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.status).toBe("claimed");
    expect(workerIds).toContain(row!.claimedBy);
    // The winning result and the DB's own record of who claimed it must agree.
    expect(row!.claimedBy).toBe(winners[0]![0]!.claimedBy);
  });

  it("claims nothing when the queue has no due jobs", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const testWorkers = await createTestWorkers(db, 1);
    const workerIds = testWorkers.map((w) => w.id);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds });

    const claimed = await claimJobs(db, queue.id, 5, workerIds[0]!);
    expect(claimed).toHaveLength(0);
  });
});
