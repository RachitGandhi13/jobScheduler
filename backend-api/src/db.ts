import { createDb } from "@scheduler/db";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

export const db = createDb(DATABASE_URL);
