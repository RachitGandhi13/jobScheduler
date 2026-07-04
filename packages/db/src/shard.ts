import crypto from "node:crypto";

/**
 * Fixed hash space jobs.shard_key routes into, independent of any one
 * queue's shardCount -- so a queue's shardCount can change later without
 * needing every existing job's shard_key recomputed. A worker group filters
 * `shard_key % queue.shardCount = WORKER_SHARD_INDEX`.
 */
export const SHARD_KEY_SPACE = 1024;

/**
 * Deterministic shard key for a job id, computed once at insert time (jobs.id
 * is generated client-side specifically so this can run before the row
 * exists -- see routes/jobs.ts and execute.ts for the two insertion call
 * sites that both need it).
 */
export function computeShardKey(jobId: string, space: number = SHARD_KEY_SPACE): number {
  const hash = crypto.createHash("sha1").update(jobId).digest();
  return hash.readUInt32BE(0) % space;
}
