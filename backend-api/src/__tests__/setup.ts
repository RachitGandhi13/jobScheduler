import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb, type Database } from "@scheduler/db";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/scheduler_test";

// Route/middleware modules (rbac.ts, auth.ts, projectAccess.ts, ...) import
// the shared `db` singleton from ../db.ts directly rather than taking it as a
// parameter, and that module throws at import time if DATABASE_URL is unset.
// Point it at the same test database so those modules are importable here too.
process.env.DATABASE_URL ??= TEST_DATABASE_URL;

let dbInstance: Database | null = null;

/** Shared test DB connection -- lazily created so importing this file has no side effect. */
export function getTestDb(): Database {
  if (!dbInstance) dbInstance = createDb(TEST_DATABASE_URL);
  return dbInstance;
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/drizzle");

beforeAll(async () => {
  // Idempotent: drizzle tracks applied migrations, so re-running per test
  // file is a safe no-op after the first.
  const migrationClient = postgres(TEST_DATABASE_URL, { max: 1 });
  await migrate(drizzle(migrationClient), { migrationsFolder });
  await migrationClient.end();
});
