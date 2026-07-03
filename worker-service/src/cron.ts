import cronParser from "cron-parser";

/** Computes the next occurrence of a cron expression, from `from` (defaults to now). */
export function getNextCronRun(cronExpression: string, from: Date = new Date()): Date {
  const interval = cronParser.parseExpression(cronExpression, { currentDate: from });
  return interval.next().toDate();
}
