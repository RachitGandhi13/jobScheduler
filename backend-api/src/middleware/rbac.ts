import { and, eq } from "drizzle-orm";
import { organizationMembers } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import type { OrganizationRole } from "../types/context.js";

/**
 * Gate a route to callers whose organization_members.role is one of `allowed`.
 * Must run after `authenticate` (needs req.context.{userId, organizationId}).
 * Structural changes (creating/renaming/deleting projects and queues) require
 * owner/admin; day-to-day job/queue operation (pause, resume, retry, enqueue)
 * is left open to every role -- see DEVELOPMENT.md for the split.
 */
export function requireRole(...allowed: OrganizationRole[]) {
  return asyncHandler(async (req, _res, next) => {
    const { userId, organizationId } = req.context;

    const [membership] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
      .limit(1);

    if (!membership) {
      throw ApiError.forbidden("not_a_member", "You are not a member of this organization");
    }
    if (!allowed.includes(membership.role)) {
      throw ApiError.forbidden(
        "insufficient_role",
        `This action requires one of: ${allowed.join(", ")} (you are '${membership.role}')`,
      );
    }

    req.context.role = membership.role;
    next();
  });
}
