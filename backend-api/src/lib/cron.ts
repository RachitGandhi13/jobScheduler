import cronParser from "cron-parser";
import { ApiError } from "./apiError.js";

/** Computes the next occurrence of a cron expression, from `from` (defaults to now). */
export function getNextCronRun(cronExpression: string, from: Date = new Date()): Date {
  try {
    const interval = cronParser.parseExpression(cronExpression, { currentDate: from });
    return interval.next().toDate();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw ApiError.badRequest("invalid_cron_expression", `Invalid cron expression "${cronExpression}": ${reason}`);
  }
}
