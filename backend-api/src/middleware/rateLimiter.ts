import { eq } from "drizzle-orm";
import { organizations, queues } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";

/** Used when neither the queue nor its organization has an explicit override configured. */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

interface Bucket {
  tokens: number;
  capacity: number;
  lastRefillAt: number;
}

/**
 * Classic token bucket, one per rate-limit key. In-memory and per-process --
 * correct and sufficient for this project's single-instance Render deploy,
 * but would under-count across multiple backend-api instances behind a load
 * balancer (each instance would enforce the limit independently, so the
 * effective ceiling becomes limit * instanceCount). A shared store (Redis)
 * is the natural next step if this API ever runs on more than one instance
 * -- not built here since nothing else in this project's stack assumes
 * Redis is available (see DEVELOPMENT.md).
 */
const buckets = new Map<string, Bucket>();

function takeToken(key: string, capacityPerMinute: number): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const refillPerMs = capacityPerMinute / 60_000;

  let bucket = buckets.get(key);
  if (!bucket || bucket.capacity !== capacityPerMinute) {
    bucket = { tokens: capacityPerMinute, capacity: capacityPerMinute, lastRefillAt: now };
    buckets.set(key, bucket);
  }

  const elapsedMs = now - bucket.lastRefillAt;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedMs * refillPerMs);
  bucket.lastRefillAt = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const retryAfterSeconds = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
  return { allowed: false, retryAfterSeconds };
}

/**
 * Gates job-ingestion endpoints (POST /jobs, POST /jobs/batch) with a
 * token-bucket rate limit, resolved queue-level override -> org-level
 * default -> code-level fallback. Must run after `validate({ body })` (needs
 * req.body.queueId already parsed) and after `requireProjectAccess`.
 *
 * One request = one token, whether it's a single POST /jobs or a
 * POST /jobs/batch inserting hundreds of rows in one call -- this limits
 * ingestion *request rate*, not job volume; a batch endpoint existing
 * specifically to make large volume cheap in one call would be undermined by
 * counting per-job against the same budget as a single-job request.
 */
export const rateLimitJobIngestion = asyncHandler(async (req, _res, next) => {
  const organizationId = req.context.organizationId;
  const queueId = (req.body as { queueId?: string } | undefined)?.queueId;

  const [organization] = await db
    .select({ rateLimitPerMinute: organizations.rateLimitPerMinute })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  let queueLimit: number | null = null;
  if (queueId) {
    const [queue] = await db
      .select({ rateLimitPerMinute: queues.rateLimitPerMinute })
      .from(queues)
      .where(eq(queues.id, queueId))
      .limit(1);
    queueLimit = queue?.rateLimitPerMinute ?? null;
  }

  const limit = queueLimit ?? organization?.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const key = queueId ? `queue:${queueId}` : `org:${organizationId}`;

  const { allowed, retryAfterSeconds } = takeToken(key, limit);
  if (!allowed) {
    _res.set("Retry-After", String(retryAfterSeconds));
    return next(
      new ApiError(
        429,
        "rate_limit_exceeded",
        `Rate limit of ${limit} requests/minute exceeded for this ${queueId ? "queue" : "organization"}. Retry after ${retryAfterSeconds}s.`,
      ),
    );
  }

  next();
});
