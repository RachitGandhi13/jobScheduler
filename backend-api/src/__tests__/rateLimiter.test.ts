import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { queues } from "@scheduler/db";
import { rateLimitJobIngestion } from "../middleware/rateLimiter.js";
import { cleanupTestFixtures, createTestQueue } from "./fixtures.js";
import { getTestDb } from "./setup.js";

/** Same asyncHandler gotcha as rbac.test.ts: wait for `next` to actually fire, not for the middleware call itself to resolve. */
function runMiddleware(middleware: (req: any, res: any, next: (err?: unknown) => void) => void, req: unknown, res: unknown) {
  return new Promise<unknown>((resolve) => {
    middleware(req, res, (err?: unknown) => resolve(err));
  });
}

function fakeRes() {
  const headers: Record<string, string> = {};
  return { set: (key: string, value: string) => { headers[key] = value; }, headers };
}

describe("rateLimitJobIngestion -- token bucket", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("allows requests up to the queue's configured limit, then rejects with 429 and a Retry-After header", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id });

    await db.update(queues).set({ rateLimitPerMinute: 2 }).where(eq(queues.id, queue.id));

    const req = { context: { organizationId: org.id }, body: { queueId: queue.id } };

    const first = await runMiddleware(rateLimitJobIngestion, req, fakeRes());
    const second = await runMiddleware(rateLimitJobIngestion, req, fakeRes());
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();

    const res3 = fakeRes();
    const third = (await runMiddleware(rateLimitJobIngestion, req, res3)) as any;
    expect(third).toBeDefined();
    expect(third.statusCode).toBe(429);
    expect(third.code).toBe("rate_limit_exceeded");
    expect(res3.headers["Retry-After"]).toBeDefined();
  });

  it("tracks separate queues independently -- exhausting one queue's bucket doesn't affect another", async () => {
    const db = getTestDb();
    const { org, user, queue } = await createTestQueue(db);
    const { org: org2, user: user2, queue: queue2 } = await createTestQueue(db);
    cleanup = async () => {
      await cleanupTestFixtures(db, { organizationId: org.id, userId: user.id });
      await cleanupTestFixtures(db, { organizationId: org2.id, userId: user2.id });
    };

    await db.update(queues).set({ rateLimitPerMinute: 1 }).where(eq(queues.id, queue.id));
    await db.update(queues).set({ rateLimitPerMinute: 1 }).where(eq(queues.id, queue2.id));

    const reqA = { context: { organizationId: org.id }, body: { queueId: queue.id } };
    const reqB = { context: { organizationId: org2.id }, body: { queueId: queue2.id } };

    await runMiddleware(rateLimitJobIngestion, reqA, fakeRes()); // exhausts queue A's single token
    const stillAllowedForB = await runMiddleware(rateLimitJobIngestion, reqB, fakeRes());
    expect(stillAllowedForB).toBeUndefined();

    const blockedForA = (await runMiddleware(rateLimitJobIngestion, reqA, fakeRes())) as any;
    expect(blockedForA?.statusCode).toBe(429);
  });
});
