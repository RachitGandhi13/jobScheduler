import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

/**
 * Structured JSON in production (what Render's log viewer / any aggregator
 * wants to ingest); human-readable via pino-pretty in local dev. pino-pretty
 * is a devDependency on purpose -- it must never be required in the
 * production bundle, so the transport is only referenced when NODE_ENV isn't
 * "production".
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: isProd
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});
