import { afterEach, describe, expect, it } from "vitest";
import { organizationMembers } from "@scheduler/db";
import { requireRole } from "../middleware/rbac.js";
import { cleanupTestFixtures, createTestQueue } from "./fixtures.js";
import { getTestDb } from "./setup.js";

/**
 * Exercises requireRole directly against a real organization_members row --
 * no Express app needs to be spun up, since the middleware it returns is just
 * (req, res, next). asyncHandler's wrapper doesn't return the inner promise
 * (fn(...).catch(next) isn't returned), so awaiting the call itself resolves
 * immediately; this helper instead waits for `next` to actually be invoked.
 */
function runMiddleware(middleware: (req: any, res: any, next: (err?: unknown) => void) => void, req: unknown) {
  return new Promise<unknown>((resolve) => {
    middleware(req, {}, (err?: unknown) => resolve(err));
  });
}

describe("requireRole -- RBAC middleware", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("calls next() with no error for a role in the allow-list", async () => {
    const db = getTestDb();
    const { org, user } = await createTestQueue(db);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id });

    await db.insert(organizationMembers).values({ organizationId: org.id, userId: user.id, role: "owner" });

    const req = { context: { userId: user.id, organizationId: org.id } };
    const nextArg = await runMiddleware(requireRole("owner", "admin"), req);

    expect(nextArg).toBeUndefined();
    expect((req as any).context.role).toBe("owner");
  });

  it("calls next() with a 403 ApiError for a role outside the allow-list", async () => {
    const db = getTestDb();
    const { org, user } = await createTestQueue(db);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id });

    await db.insert(organizationMembers).values({ organizationId: org.id, userId: user.id, role: "member" });

    const req = { context: { userId: user.id, organizationId: org.id } };
    const nextArg = (await runMiddleware(requireRole("owner", "admin"), req)) as any;

    expect(nextArg).toBeDefined();
    expect(nextArg.statusCode).toBe(403);
    expect(nextArg.code).toBe("insufficient_role");
  });

  it("calls next() with a 403 ApiError when the caller has no membership row at all", async () => {
    const db = getTestDb();
    const { org, user } = await createTestQueue(db);
    cleanup = () => cleanupTestFixtures(db, { organizationId: org.id, userId: user.id });
    // Deliberately no organizationMembers row inserted for this user.

    const req = { context: { userId: user.id, organizationId: org.id } };
    const nextArg = (await runMiddleware(requireRole("owner"), req)) as any;

    expect(nextArg).toBeDefined();
    expect(nextArg.statusCode).toBe(403);
    expect(nextArg.code).toBe("not_a_member");
  });
});
