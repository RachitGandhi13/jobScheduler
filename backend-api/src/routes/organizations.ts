import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireRole } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";

/** Mounted directly on apiRouter (org-scoped, no :projectId in the path). */
export const organizationsRouter = Router();

/** GET /api/organizations/me -- the caller's own organization, incl. its rate-limit default. */
organizationsRouter.get(
  "/organizations/me",
  asyncHandler(async (req, res) => {
    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.context.organizationId))
      .limit(1);
    if (!organization) {
      throw ApiError.notFound("organization_not_found", "Organization not found");
    }
    res.json({ data: organization });
  }),
);

const updateOrganizationBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  // Org-wide default for job-ingestion rate limiting (requests/minute); a
  // queue's own rateLimitPerMinute, if set, overrides this. null clears the
  // override back to the code-level fallback (see middleware/rateLimiter.ts).
  rateLimitPerMinute: z.number().int().min(1).nullable().optional(),
});

/** PATCH /api/organizations/me -- rename the org and/or set its default rate limit. Requires owner/admin. */
organizationsRouter.patch(
  "/organizations/me",
  requireRole("owner", "admin"),
  validate({ body: updateOrganizationBodySchema }),
  asyncHandler(async (req, res) => {
    const { name, rateLimitPerMinute } = req.body as z.infer<typeof updateOrganizationBodySchema>;

    const patch: Partial<typeof organizations.$inferInsert> = { updatedAt: new Date() };
    if (name !== undefined) patch.name = name;
    if (rateLimitPerMinute !== undefined) patch.rateLimitPerMinute = rateLimitPerMinute;

    const [updated] = await db
      .update(organizations)
      .set(patch)
      .where(eq(organizations.id, req.context.organizationId))
      .returning();

    res.json({ data: updated });
  }),
);
