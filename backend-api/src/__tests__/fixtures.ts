import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { organizations, projects, queues, retryPolicies, users, workers, type Database } from "@scheduler/db";

export async function createTestQueue(db: Database) {
  const suffix = crypto.randomUUID();

  const [org] = await db
    .insert(organizations)
    .values({ name: `Test Org ${suffix}`, slug: `test-org-${suffix}` })
    .returning();

  const [user] = await db
    .insert(users)
    .values({ email: `test-${suffix}@test.local`, passwordHash: "x" })
    .returning();

  const [project] = await db
    .insert(projects)
    .values({ organizationId: org.id, name: "Test Project", ownerId: user.id, apiKey: suffix })
    .returning();

  const [queue] = await db
    .insert(queues)
    .values({ projectId: project.id, name: `test-queue-${suffix}`, concurrencyLimit: 10 })
    .returning();

  const [retryPolicy] = await db
    .insert(retryPolicies)
    .values({ queueId: queue.id, strategy: "fixed", maxRetries: 3, baseDelayMs: 1000 })
    .returning();

  return { org, user, project, queue, retryPolicy };
}

export async function cleanupTestFixtures(
  db: Database,
  ids: { organizationId: string; userId: string; workerIds?: string[] },
): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, ids.organizationId));
  await db.delete(users).where(eq(users.id, ids.userId));
  if (ids.workerIds?.length) {
    for (const workerId of ids.workerIds) {
      await db.delete(workers).where(eq(workers.id, workerId));
    }
  }
}
