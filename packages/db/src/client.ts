import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
  // prepare: false -- required for Neon's pooled (PgBouncer transaction-mode)
  // connection string: a prepared statement can silently end up on a
  // different backend connection than the one that created it. Safe to leave
  // on for direct connections too, just slightly less efficient.
  const client = postgres(connectionString, { prepare: false });
  return drizzle(client, { schema });
}
