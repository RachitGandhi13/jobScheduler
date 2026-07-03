import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { ApiError } from "../lib/apiError.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";
// Dev/testing escape hatch until a real login endpoint exists: lets requests
// authenticate via x-mock-user-id / x-mock-organization-id headers instead of
// a signed token. Must never be enabled in production.
const MOCK_AUTH = process.env.MOCK_AUTH === "true";

interface JwtPayload {
  userId: string;
  organizationId: string;
}

/**
 * Populates req.context.{userId, organizationId} from a verified JWT, or (only
 * when MOCK_AUTH=true) from mock headers. Runs before requireProjectAccess,
 * which further scopes the request to a specific project.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");

  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length);
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
      req.context = { userId: decoded.userId, organizationId: decoded.organizationId };
      return next();
    } catch {
      return next(ApiError.unauthorized("invalid_token", "Invalid or expired token"));
    }
  }

  if (MOCK_AUTH) {
    const userId = req.header("x-mock-user-id");
    const organizationId = req.header("x-mock-organization-id");
    if (userId && organizationId) {
      req.context = { userId, organizationId };
      return next();
    }
    return next(
      ApiError.unauthorized(
        "missing_mock_headers",
        "MOCK_AUTH requires x-mock-user-id and x-mock-organization-id headers",
      ),
    );
  }

  return next(ApiError.unauthorized("missing_token", "Authorization: Bearer <token> header required"));
}
