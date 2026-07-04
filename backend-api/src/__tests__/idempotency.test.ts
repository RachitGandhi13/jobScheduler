import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { jobs, queues } from "@scheduler/db";
import { cleanupTestFixtures, createTestQueue } from "./fixtures.js";
import { getTestDb } from "./setup.js";

/**
 * Exercises the DB constraint POST /jobs relies on for its idempotency-key
 * dedupe (jobs_queue_id_idempotency_key_idx in schema.ts) directly, rather
 * than the route handler -- the same guarantee either way, since the route's
 * pre-check + catch(23505) both bottom out at this index.
 */
describe("jobs.idempotencyKey -- per-queue dedupe constraint", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("rejects a second insert on the same queue reusing an idempotency key", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id });

    await db.insert(jobs).values({ queueId: queue.id, type: "charge-card", idempotencyKey: "order-42", runAt: new Date() });

    await expect(
      db.insert(jobs).values({ queueId: queue.id, type: "charge-card", idempotencyKey: "order-42", runAt: new Date() }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("allows the same idempotency key to be reused across different queues", async () => {
    const db = getTestDb();
    const { org, user, project, queue } = await createTestQueue(db);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id });

    const [otherQueue] = await db
      .insert(queues)
      .values({ projectId: project.id, name: `other-queue-${crypto.randomUUID()}` })
      .returning();

    // Same key, two different queues -- the unique index is
    // (queue_id, idempotency_key), so this is not a collision.
    const [job1] = await db
      .insert(jobs)
      .values({ queueId: queue.id, type: "charge-card", idempotencyKey: "shared-key", runAt: new Date() })
      .returning();
    const [job2] = await db
      .insert(jobs)
      .values({ queueId: otherQueue.id, type: "charge-card", idempotencyKey: "shared-key", runAt: new Date() })
      .returning();

    expect(job1.id).not.toBe(job2.id);
  });

  it("allows unlimited jobs with no idempotency key on the same queue (NULLs are distinct)", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id });

    const [a] = await db.insert(jobs).values({ queueId: queue.id, type: "noop", runAt: new Date() }).returning();
    const [b] = await db.insert(jobs).values({ queueId: queue.id, type: "noop", runAt: new Date() }).returning();

    expect(a.idempotencyKey).toBeNull();
    expect(b.idempotencyKey).toBeNull();
    expect(a.id).not.toBe(b.id);
  });
});
