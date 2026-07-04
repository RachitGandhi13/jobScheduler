import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireProjectAccess } from "../middleware/projectAccess.js";
import { authRouter } from "./auth.js";
import { jobsRouter } from "./jobs.js";
import { metricsRouter } from "./metrics.js";
import { projectDetailRouter, projectsRouter } from "./projects.js";
import { queuesRouter } from "./queues.js";
import { workersRouter } from "./workers.js";

const projectRouter = Router({ mergeParams: true });
projectRouter.use(requireProjectAccess);
projectRouter.use(jobsRouter);
projectRouter.use(queuesRouter);
projectRouter.use(metricsRouter);
// Root of this sub-router (GET/PATCH/DELETE /api/projects/:projectId itself),
// mounted last so it doesn't shadow the more specific /jobs, /queues, /metrics paths.
projectRouter.use(projectDetailRouter);

export const apiRouter = Router();
// Public: signup/login issue the token that every other route below requires.
// /auth/me is the one exception inside this router that still needs a token,
// so it carries its own `authenticate` (see auth.ts).
apiRouter.use(authRouter);

apiRouter.use(authenticate);
// Fleet-wide, not project-scoped -- see workers.ts for why.
apiRouter.use(workersRouter);
// Org-scoped list/create -- must come before the :projectId sub-router so
// GET/POST /api/projects resolve here rather than being swallowed as an
// (invalid) :projectId value.
apiRouter.use(projectsRouter);
apiRouter.use("/projects/:projectId", projectRouter);
