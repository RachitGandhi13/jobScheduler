import type { Server as HttpServer } from "node:http";
import { eq, inArray, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";
import { deadLetterQueue, jobs, projects, queues, workerHeartbeats, workers } from "@scheduler/db";
import { db } from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret";
const PUSH_INTERVAL_MS = Number(process.env.WS_PUSH_INTERVAL_MS ?? 3000);
const JOB_STATUSES = ["queued", "scheduled", "claimed", "running", "completed", "failed"] as const;

interface JwtPayload {
  userId: string;
  organizationId: string;
}

/**
 * Same two reads GET /workers and GET /metrics already do, run together for
 * one WS push. backend-api still just polls its own database on an interval
 * here -- worker-service is a separate, often-ephemeral process (GitHub
 * Actions runs, not a co-located thread), so there is no in-process event to
 * subscribe to instead. What the socket removes is the *frontend's* HTTP
 * request/response round trip, not backend-api's own DB polling.
 */
async function buildSnapshot(projectId: string) {
  const latestHeartbeats = db
    .select({
      workerId: workerHeartbeats.workerId,
      latestAt: sql<Date>`max(${workerHeartbeats.heartbeatAt})`.as("latest_at"),
    })
    .from(workerHeartbeats)
    .groupBy(workerHeartbeats.workerId)
    .as("latest_heartbeats");

  const workerRows = await db
    .select({
      id: workers.id,
      hostname: workers.hostname,
      pid: workers.pid,
      status: workers.status,
      startedAt: workers.startedAt,
      createdAt: workers.createdAt,
      lastHeartbeatAt: latestHeartbeats.latestAt,
    })
    .from(workers)
    .leftJoin(latestHeartbeats, eq(latestHeartbeats.workerId, workers.id));

  const projectQueues = await db.select({ id: queues.id }).from(queues).where(eq(queues.projectId, projectId));
  const queueIds = projectQueues.map((q) => q.id);

  const jobCounts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<(typeof JOB_STATUSES)[number], number>;
  let deadLetterCount = 0;

  if (queueIds.length > 0) {
    const counts = await db
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(inArray(jobs.queueId, queueIds))
      .groupBy(jobs.status);
    for (const row of counts) jobCounts[row.status] = row.count;

    const [dlq] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deadLetterQueue)
      .where(inArray(deadLetterQueue.queueId, queueIds));
    deadLetterCount = dlq?.count ?? 0;
  }

  return {
    workers: workerRows,
    metrics: { queueCount: queueIds.length, jobCounts, deadLetterCount },
  };
}

/**
 * Attaches a `/ws` WebSocket endpoint to the same HTTP server Express is
 * already listening on (see index.ts) -- one port, one deploy target, no
 * separate WS service to stand up on Render. Auth is a `token` query param
 * (the same JWT everything else uses) rather than a header, since the
 * browser WebSocket constructor can't set Authorization on the handshake
 * request.
 *
 * Each connection gets its own push interval scoped to its :projectId --
 * this is a small-scale dashboard (single Render instance, not a fleet of
 * WS gateways), so per-connection polling is simple and correct rather than
 * a shared pub/sub layer that would only pay for itself at a scale this
 * project doesn't run at.
 */
export function attachLiveServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, req) => {
    void (async () => {
      const url = new URL(req.url ?? "", "http://internal");
      const token = url.searchParams.get("token");
      const projectId = url.searchParams.get("projectId");

      if (!token || !projectId) {
        socket.close(4001, "token and projectId query params are required");
        return;
      }

      let payload: JwtPayload;
      try {
        payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
      } catch {
        socket.close(4001, "invalid or expired token");
        return;
      }

      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!project || project.organizationId !== payload.organizationId) {
        socket.close(4003, "project not found or does not belong to your organization");
        return;
      }

      const pushSnapshot = async () => {
        if (socket.readyState !== socket.OPEN) return;
        try {
          const snapshot = await buildSnapshot(projectId);
          socket.send(JSON.stringify({ type: "snapshot", data: snapshot }));
        } catch (err) {
          console.error("[ws] failed to build snapshot", err);
        }
      };

      await pushSnapshot();
      const interval = setInterval(() => void pushSnapshot(), PUSH_INTERVAL_MS);
      socket.on("close", () => clearInterval(interval));
      socket.on("error", () => clearInterval(interval));
    })();
  });

  return wss;
}
