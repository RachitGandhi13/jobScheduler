import type { InferSelectModel } from "drizzle-orm";
import type { projects } from "@scheduler/db";

export interface AuthContext {
  userId: string;
  organizationId: string;
  /** Set by requireProjectAccess once the :projectId route param has been verified. */
  projectId?: string;
  project?: InferSelectModel<typeof projects>;
}

declare global {
  namespace Express {
    interface Request {
      context: AuthContext;
    }
  }
}
