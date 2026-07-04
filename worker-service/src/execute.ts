import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import {
  computeShardKey,
  deadLetterQueue,
  jobExecutions,
  jobLogs,
  jobs,
  retryPolicies,
  scheduledJobs,
  type Database,
} from "@scheduler/db";
import { getNextCronRun } from "./cron.js";
import { summarizeFailure } from "./failureSummary.js";
import { computeNextRunAt } from "./retry.js";

type Job = InferSelectModel<typeof jobs>;
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
export async function executeClaimedJob(db: Database, job: Job, workerId: string): Promise<void> {
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

      if (job.scheduledJobId) {
        // The recurring *rule* lives in scheduled_jobs, isolated from this hot
        // table -- fetch it fresh rather than trusting the parent job's own
        // columns, since the rule is the authoritative template.
        const [rule] = await tx.select().from(scheduledJobs).where(eq(scheduledJobs.id, job.scheduledJobId)).limit(1);

        if (rule?.isActive) {
          // Chained from job.runAt (the occurrence that just ran), not now(),
          // so the cadence stays locked to the original schedule instead of
          // drifting with however long execution happened to take. Status
          // 'scheduled' matches how delayed/recurring jobs are created via
          // the API -- claimable the instant run_at is due, no promotion step.
          const nextRunAt = getNextCronRun(rule.cronExpression, job.runAt);
          const childId = crypto.randomUUID();

          const [child] = await tx
            .insert(jobs)
            .values({
              id: childId,
              queueId: rule.queueId,
              type: rule.type,
              payload: rule.payload,
              priority: rule.priority,
              maxAttempts: rule.maxAttempts,
              runAt: nextRunAt,
              status: "scheduled",
              scheduledJobId: rule.id,
              shardKey: computeShardKey(childId),
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
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    const willDeadLetter = attemptNumber >= job.maxAttempts;

    // Computed outside the transaction on purpose: summarizeFailure() may
    // make a real network call (the Claude API path), and a DB transaction
    // must never sit open across one -- that would hold a connection (a
    // scarce resource under Neon's pooling) for however long that call takes.
    const aiSummary = willDeadLetter
      ? await summarizeFailure({ jobType: job.type, failReason: message, attempts: attemptNumber }).catch(() => null)
      : null;

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

      if (willDeadLetter) {
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
          aiSummary,
        });

        await log(tx, job.id, execution.id, "error", "Max attempts exceeded — moved to dead letter queue");
      } else {
        const [retryPolicy] = await tx.select().from(retryPolicies).where(eq(retryPolicies.queueId, job.queueId)).limit(1);
        const strategy = retryPolicy?.strategy ?? "fixed";
        const baseDelayMs = retryPolicy?.baseDelayMs ?? 1000;
        const nextRunAt = computeNextRunAt(strategy, baseDelayMs, attemptNumber);

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
          `Retry ${attemptNumber + 1} scheduled at ${nextRunAt.toISOString()} (${strategy} backoff)`,
        );
      }
    });
  }
}
