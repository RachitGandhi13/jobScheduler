import { eq } from "drizzle-orm";
import { projects } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Multi-tenant boundary: resolves :projectId and rejects the request unless
 * the project belongs to the authenticated caller's organization. Must run
 * after `authenticate` (needs req.context.organizationId) and before any
 * project-scoped route handler.
 */
export const requireProjectAccess = asyncHandler(async (req, _res, next) => {
  const { projectId } = req.params;
  if (!projectId || !UUID_RE.test(projectId)) {
    throw ApiError.badRequest("invalid_project_id", "projectId must be a UUID");
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    throw ApiError.notFound("project_not_found", "Project not found");
  }
  if (project.organizationId !== req.context.organizationId) {
    throw ApiError.forbidden("project_forbidden", "Project does not belong to your organization");
  }

  req.context.projectId = project.id;
  req.context.project = project;
  next();
});
