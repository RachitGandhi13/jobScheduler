import { eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import {
  deadLetterQueue,
  jobExecutions,
  jobLogs,
  jobs,
  queues,
  type Database,
} from "@scheduler/db";
import { getNextCronRun } from "./cron.js";
import { computeNextRunAt } from "./retry.js";

type Job = InferSelectModel<typeof jobs>;
type Queue = InferSelectModel<typeof queues>;
// Accepts either the top-level Database or a transaction handle, so `log` can
// be called from inside db.transaction(...) without a separate helper.
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Db = Database | Tx;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function log(
  db: Db,
  jobId: string,
  executionId: string,
  level: "debug" | "info" | "warn" | "error",
  message: string,
) {
  await db.insert(jobLogs).values({ jobId, executionId, level, message });
}

/**
 * Placeholder for a real job-type -> handler registry. Simulates variable
 * work duration and, for demo/testing, lets a job force a failure via
 * payload.simulateFailure or payload.failureRate.
 */
async function runSimulatedTask(job: Job): Promise<void> {
  const workMs = 200 + Math.random() * 800;
  await sleep(workMs);

  const payload = (job.payload ?? {}) as { simulateFailure?: boolean; failureRate?: number };
  const shouldFail =
    payload.simulateFailure === true ||
    (typeof payload.failureRate === "number" && Math.random() < payload.failureRate);

  if (shouldFail) {
    throw new Error(`Simulated failure for job type "${job.type}"`);
  }
}

/**
 * Runs one claimed job through Running -> {Completed | retry-Queued | Failed+DLQ}.
 * Never throws: all outcomes, including infra errors, are captured as job state
 * so a bug here can't leave a job stuck in 'claimed'/'running' forever (the
 * zombie cleanup monitor is the backstop for a worker process dying mid-execution).
 */
export async function executeClaimedJob(
  db: Database,
  job: Job,
  queue: Queue,
  workerId: string,
): Promise<void> {
  const attemptNumber = job.attempts + 1;
  const startedAt = new Date();

  const [execution] = await db
    .insert(jobExecutions)
    .values({ jobId: job.id, workerId, attemptNumber, status: "running", startedAt })
    .returning();

  await db
    .update(jobs)
    .set({ status: "running", startedAt, updatedAt: new Date() })
    .where(eq(jobs.id, job.id));

  await log(db, job.id, execution.id, "info", `Attempt ${attemptNumber} started`);

  try {
    await runSimulatedTask(job);
    const finishedAt = new Date();

    // Completion, next-occurrence chaining and their log entries commit as one
    // unit: a recurring series can never silently die from a crash landing
    // between "marked completed" and "next occurrence inserted".
    await db.transaction(async (tx) => {
      await tx
        .update(jobExecutions)
        .set({ status: "success", finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime() })
        .where(eq(jobExecutions.id, execution.id));

      await tx
        .update(jobs)
        .set({ status: "completed", attempts: attemptNumber, completedAt: finishedAt, updatedAt: finishedAt })
        .where(eq(jobs.id, job.id));

      await log(tx, job.id, execution.id, "info", "Completed successfully");

      if (job.cronExpression) {
        // Chained from job.runAt (the occurrence that just ran), not now(), so
        // the cadence stays locked to the original schedule instead of
        // drifting with however long execution happened to take. Status
        // 'scheduled' matches how delayed/recurring jobs are created via the
        // API -- claimable the instant run_at is due, no promotion step.
        const nextRunAt = getNextCronRun(job.cronExpression, job.runAt);

        const [child] = await tx
          .insert(jobs)
          .values({
            queueId: job.queueId,
            type: job.type,
            payload: job.payload,
            priority: job.priority,
            maxAttempts: job.maxAttempts,
            runAt: nextRunAt,
            status: "scheduled",
            cronExpression: job.cronExpression,
          })
          .returning({ id: jobs.id });

        await log(
          tx,
          job.id,
          execution.id,
          "info",
          `Recurring: next occurrence ${child.id} scheduled for ${nextRunAt.toISOString()}`,
        );
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(jobExecutions)
        .set({
          status: "failure",
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: message,
        })
        .where(eq(jobExecutions.id, execution.id));

      await log(tx, job.id, execution.id, "error", `Attempt ${attemptNumber} failed: ${message}`);

      if (attemptNumber >= job.maxAttempts) {
        await tx
          .update(jobs)
          .set({ status: "failed", attempts: attemptNumber, lastError: message, updatedAt: finishedAt })
          .where(eq(jobs.id, job.id));

        await tx.insert(deadLetterQueue).values({
          jobId: job.id,
          queueId: job.queueId,
          payload: job.payload,
          attempts: attemptNumber,
          failReason: message,
        });

        await log(tx, job.id, execution.id, "error", "Max attempts exceeded — moved to dead letter queue");
      } else {
        const nextRunAt = computeNextRunAt(queue.retryStrategy, queue.retryBaseDelayMs, attemptNumber);

        await tx
          .update(jobs)
          .set({
            status: "queued",
            attempts: attemptNumber,
            runAt: nextRunAt,
            claimedBy: null,
            claimedAt: null,
            lastError: message,
            updatedAt: finishedAt,
          })
          .where(eq(jobs.id, job.id));

        await log(
          tx,
          job.id,
          execution.id,
          "warn",
          `Retry ${attemptNumber + 1} scheduled at ${nextRunAt.toISOString()} (${queue.retryStrategy} backoff)`,
        );
      }
    });
  }
}
