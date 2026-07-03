import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireProjectAccess } from "../middleware/projectAccess.js";
import { authRouter } from "./auth.js";
import { jobsRouter } from "./jobs.js";
import { metricsRouter } from "./metrics.js";
import { queuesRouter } from "./queues.js";
import { workersRouter } from "./workers.js";

const projectRouter = Router({ mergeParams: true });
projectRouter.use(requireProjectAccess);
projectRouter.use(jobsRouter);
projectRouter.use(queuesRouter);
projectRouter.use(metricsRouter);

export const apiRouter = Router();
// Public: signup/login issue the token that every other route below requires.
// /auth/me is the one exception inside this router that still needs a token,
// so it carries its own `authenticate` (see auth.ts).
apiRouter.use(authRouter);

apiRouter.use(authenticate);
// Fleet-wide, not project-scoped -- see workers.ts for why.
apiRouter.use(workersRouter);
apiRouter.use("/projects/:projectId", projectRouter);
