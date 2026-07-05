import crypto from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { and, asc, eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { organizationMembers, organizations, projects, queues, retryPolicies, users } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";
const TOKEN_TTL = "7d";

function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${base || "org"}-${crypto.randomBytes(3).toString("hex")}`;
}

function issueToken(userId: string, organizationId: string): string {
  return jwt.sign({ userId, organizationId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

const signupBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(255),
  name: z.string().min(1).max(255).optional(),
  organizationName: z.string().min(1).max(255),
});

/**
 * POST /api/auth/signup
 *
 * Minimal onboarding: one call creates a User, an Organization owned by them,
 * and a Default Project + Default Queue so a fresh signup lands somewhere
 * usable immediately, without a separate "create your first project" step.
 * All in one transaction -- either the whole workspace exists or none of it does.
 */
authRouter.post(
  "/auth/signup",
  validate({ body: signupBodySchema }),
  asyncHandler(async (req, res) => {
    const { email, password, name, organizationName } = req.body as z.infer<typeof signupBodySchema>;

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      throw ApiError.conflict("email_taken", "An account with this email already exists");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email, passwordHash, name }).returning();

      const [organization] = await tx
        .insert(organizations)
        .values({ name: organizationName, slug: slugify(organizationName) })
        .returning();

      await tx.insert(organizationMembers).values({
        organizationId: organization.id,
        userId: user.id,
        role: "owner",
      });

      const [project] = await tx
        .insert(projects)
        .values({
          organizationId: organization.id,
          name: "Default Project",
          ownerId: user.id,
          apiKey: crypto.randomBytes(24).toString("hex"),
        })
        .returning();

      const [queue] = await tx
        .insert(queues)
        .values({
          projectId: project.id,
          name: "default",
          priority: 0,
          concurrencyLimit: 2,
        })
        .returning();

      const [retryPolicy] = await tx
        .insert(retryPolicies)
        .values({
          queueId: queue.id,
          strategy: "exponential",
          maxRetries: 3,
          baseDelayMs: 1000,
        })
        .returning();

      return { user, organization, project, queue, retryPolicy };
    });

    const token = issueToken(result.user.id, result.organization.id);

    res.status(201).json({
      data: {
        token,
        user: { id: result.user.id, email: result.user.email, name: result.user.name },
        organization: { id: result.organization.id, name: result.organization.name },
        project: { id: result.project.id, name: result.project.name },
        role: "owner",
      },
    });
  }),
);

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** POST /api/auth/login -- verifies credentials, returns a JWT + the user's first organization/project. */
authRouter.post(
  "/auth/login",
  validate({ body: loginBodySchema }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginBodySchema>;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw ApiError.unauthorized("invalid_credentials", "Email or password is incorrect");
    }

    const [membership] = await db
      .select({ organizationId: organizationMembers.organizationId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, user.id))
      .orderBy(asc(organizationMembers.createdAt))
      .limit(1);

    if (!membership) {
      throw ApiError.forbidden("no_organization", "This user does not belong to any organization");
    }

    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, membership.organizationId))
      .limit(1);

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, membership.organizationId))
      .orderBy(asc(projects.createdAt))
      .limit(1);

    const token = issueToken(user.id, membership.organizationId);

    res.json({
      data: {
        token,
        user: { id: user.id, email: user.email, name: user.name },
        organization: { id: organization.id, name: organization.name },
        project: project ? { id: project.id, name: project.name } : null,
        role: membership.role,
      },
    });
  }),
);

/** GET /api/auth/me -- rehydrates a session from a stored token (used on frontend page load). */
authRouter.get(
  "/auth/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const { userId, organizationId } = req.context;

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const [organization] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(projects.createdAt))
      .limit(1);
    const [membership] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
      .limit(1);

    if (!user || !organization) {
      throw ApiError.unauthorized("invalid_session", "User or organization from this token no longer exists");
    }

    res.json({
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        organization: { id: organization.id, name: organization.name },
        project: project ? { id: project.id, name: project.name } : null,
        role: membership?.role ?? "member",
      },
    });
  }),
);
