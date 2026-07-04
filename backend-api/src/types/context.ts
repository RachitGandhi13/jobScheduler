import type { InferSelectModel } from "drizzle-orm";
import type { projects } from "@scheduler/db";

export type OrganizationRole = "owner" | "admin" | "member";

export interface AuthContext {
  userId: string;
  organizationId: string;
  /** Set by requireProjectAccess once the :projectId route param has been verified. */
  projectId?: string;
  project?: InferSelectModel<typeof projects>;
  /** Set by requireRole once the caller's organization_members row has been looked up. */
  role?: OrganizationRole;
}

declare global {
  namespace Express {
    interface Request {
      context: AuthContext;
    }
  }
}
