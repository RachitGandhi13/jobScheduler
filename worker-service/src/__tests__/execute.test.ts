import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { deadLetterQueue, jobs, workers } from "@scheduler/db";
import { executeClaimedJob } from "../execute.js";
import { cleanupTestFixtures, createTestQueue } from "./fixtures.js";
import { getTestDb } from "./setup.js";

describe("executeClaimedJob -- failure lifecycle: backoff math, then DLQ once exhausted", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("retries with the queue's fixed backoff, then dead-letters after max_retries", async () => {
    const db = getTestDb();
    const BASE_DELAY_MS = 2000;
    const MAX_RETRIES = 2;
    const { org, user, queue } = await createTestQueue(db, {
      retryStrategy: "fixed",
      maxRetries: MAX_RETRIES,
      baseDelayMs: BASE_DELAY_MS,
    });
    const [worker] = await db.insert(workers).values({ hostname: "test", status: "idle" }).returning();
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds: [worker.id] });

    const [job] = await db
      .insert(jobs)
      .values({
        queueId: queue.id,
        type: "always-fails",
        payload: { simulateFailure: true },
        status: "claimed",
        claimedBy: worker.id,
        claimedAt: new Date(),
        maxAttempts: MAX_RETRIES,
        runAt: new Date(),
      })
      .returning();

    // --- attempt 1: should fail and reschedule per the fixed backoff ---
    await executeClaimedJob(db, job, worker.id);
    const afterAttempt1Time = Date.now();

    const [afterAttempt1] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(afterAttempt1!.status).toBe("queued");
    expect(afterAttempt1!.attempts).toBe(1);

    // Backoff is computed at failure time (now), not at some fixed offset
    // from when the test started -- isolate it from runSimulatedTask's own
    // randomized 200-1000ms duration by measuring from right after execution
    // returns, not from before it started.
    const delayFromNow = afterAttempt1!.runAt.getTime() - afterAttempt1Time;
    expect(delayFromNow).toBeGreaterThan(BASE_DELAY_MS - 250);
    expect(delayFromNow).toBeLessThan(BASE_DELAY_MS + 250);

    // --- attempt 2: exhausts max_retries -> dead-letters ---
    const [reclaimed] = await db
      .update(jobs)
      .set({ status: "claimed", claimedBy: worker.id })
      .where(eq(jobs.id, job.id))
      .returning();

    await executeClaimedJob(db, reclaimed!, worker.id);

    const [afterAttempt2] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(afterAttempt2!.status).toBe("failed");
    expect(afterAttempt2!.attempts).toBe(2);

    const [dlqRow] = await db.select().from(deadLetterQueue).where(eq(deadLetterQueue.jobId, job.id));
    expect(dlqRow).toBeDefined();
    expect(dlqRow!.attempts).toBe(2);
    expect(dlqRow!.failReason).toContain("always-fails");
  });

  it("completes successfully and never touches retry/DLQ machinery when the task doesn't fail", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const [worker] = await db.insert(workers).values({ hostname: "test", status: "idle" }).returning();
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds: [worker.id] });

    const [job] = await db
      .insert(jobs)
      .values({
        queueId: queue.id,
        type: "always-succeeds",
        status: "claimed",
        claimedBy: worker.id,
        claimedAt: new Date(),
        runAt: new Date(),
      })
      .returning();

    await executeClaimedJob(db, job, worker.id);

    const [after] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after!.status).toBe("completed");
    expect(after!.attempts).toBe(1);
    expect(after!.completedAt).not.toBeNull();

    const [dlqRow] = await db.select().from(deadLetterQueue).where(eq(deadLetterQueue.jobId, job.id));
    expect(dlqRow).toBeUndefined();
  });
});
