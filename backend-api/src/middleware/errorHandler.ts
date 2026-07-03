import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/apiError.js";

/** Must be registered last: converts ApiError into its structured JSON shape, else 500s. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  console.error("[backend-api] unhandled error", err);
  res.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
}
