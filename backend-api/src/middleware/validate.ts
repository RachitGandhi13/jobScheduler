import type { NextFunction, Request, Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { ApiError } from "../lib/apiError.js";

interface Schemas {
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  body?: ZodTypeAny;
}

/** Parses+coerces req.params/query/body against zod schemas, replacing them in place. */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        return next(ApiError.badRequest("validation_error", "Request validation failed", err.flatten()));
      }
      next(err);
    }
  };
}
