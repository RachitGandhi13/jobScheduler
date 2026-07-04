import "dotenv/config";
import cors from "cors";
import express from "express";
import { pinoHttp } from "pino-http";
import { db } from "./db.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { logger } from "./logger.js";
import { startZombieCleanup } from "./monitors/zombieCleanup.js";
import { apiRouter } from "./routes/index.js";

const PORT = process.env.PORT ?? 4000;
const ZOMBIE_CLEANUP_INTERVAL_MS = Number(process.env.ZOMBIE_CLEANUP_INTERVAL_MS ?? 10_000);
// Comma-separated list of origins the dashboard is served from. The API uses
// Bearer-token auth (never cookies), so a wide-open CORS policy wouldn't leak
// credentials the way it would for cookie-based auth -- but pinning to known
// origins is still the safer default over a blanket "*".
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim());

const app = express();
app.use(cors({ origin: CORS_ORIGINS }));
// Structured request log: method, path, status code, response time, on every
// call. /health is excluded -- it's Render's own liveness probe hitting this
// every few seconds, not a real request worth tracing.
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/health" },
  }),
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", apiRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
});
app.use(errorHandler);

startZombieCleanup(db, ZOMBIE_CLEANUP_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`backend-api listening on port ${PORT}`);
});
