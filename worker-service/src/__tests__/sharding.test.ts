import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { jobs, queues } from "@scheduler/db";
import { claimJobs } from "../claim.js";
import { cleanupTestFixtures, createTestQueue, createTestWorkers } from "./fixtures.js";
import { getTestDb } from "./setup.js";

describe("claimJobs -- queue sharding (shardKey / shardCount / workerShardIndex)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("a worker pinned to shard N only ever claims jobs whose shardKey % shardCount == N", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const [worker] = await createTestWorkers(db, 1);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds: [worker!.id] });

    await db.update(queues).set({ shardCount: 4 }).where(eq(queues.id, queue.id));

    const inserted = await db
      .insert(jobs)
      .values(
        [0, 1, 2, 3].map((shardKey) => ({
          queueId: queue.id,
          type: `shard-${shardKey}-task`,
          status: "queued" as const,
          runAt: new Date(),
          shardKey,
        })),
      )
      .returning();
    const idByShard = new Map(inserted.map((j) => [j.shardKey, j.id]));

    const claimedShard0 = await claimJobs(db, queue.id, 10, worker!.id, 0);
    expect(claimedShard0.map((j) => j.id)).toEqual([idByShard.get(0)]);

    const claimedShard2 = await claimJobs(db, queue.id, 10, worker!.id, 2);
    expect(claimedShard2.map((j) => j.id)).toEqual([idByShard.get(2)]);
  });

  it("an unsharded queue (shardCount=1, the default) is claimable in full by the default workerShardIndex=0", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const [worker] = await createTestWorkers(db, 1);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id, workerIds: [worker!.id] });

    // shardKey deliberately non-zero: with the default shardCount=1,
    // shard_key % 1 is always 0 regardless -- this is exactly why an
    // unsharded fleet (workerShardIndex defaulting to 0) sees identical
    // behavior to before sharding existed.
    await db.insert(jobs).values({ queueId: queue.id, type: "task", status: "queued", runAt: new Date(), shardKey: 777 });

    const claimed = await claimJobs(db, queue.id, 10, worker!.id);
    expect(claimed).toHaveLength(1);
  });
});
