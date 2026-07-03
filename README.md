# Distributed Job Scheduler

Production-inspired distributed job scheduling platform: multi-tenant projects/queues, a REST API, a
worker service that atomically claims and executes jobs, and a monitoring dashboard.

## Status

Phase 1 (workspace + schema), Phase 2 (atomic claim engine, job lifecycle, heartbeats, zombie
cleanup), Phase 3 (REST API, auth, queue controls) and Phase 4 (recurring job chaining, dashboard)
are in place.

## Layout

- `backend-api/` — REST API (auth, projects, queues, jobs)
- `worker-service/` — polls queues, claims jobs, executes them, sends heartbeats
- `frontend-dashboard/` — web dashboard for queues, jobs, workers, metrics
- `packages/db/` — shared Drizzle schema + DB client used by both `backend-api` and `worker-service`

## System architecture

```
+-----------------------------+
|      frontend-dashboard        |
|   Vite + React (Vercel)        |
+---------------+-----------------+
                |  REST over JSON, polled every 4-5s
                v
+-----------------------------+
|          backend-api           |
|   Express (Render web service) |
+---------------+-----------------+
                |  Drizzle ORM (reads + writes)
                v
+-----------------------------------+
|            Postgres (Neon)           |
|  users, organizations, projects,     |
|  queues, jobs, job_executions,       |
|  job_logs, workers, dead_letter_queue|
+---------------+-----------------------+
                ^
                |  Drizzle ORM: SELECT ... FOR UPDATE SKIP LOCKED
                |
+---------------+-----------------+
|         worker-service             |
|   poll -> claim -> execute         |
|   (Render background worker,       |
|    scale out with N instances)     |
+-------------------------------------+
```

Every `ZOMBIE_CLEANUP_INTERVAL_MS` (default 10s), `backend-api`'s zombie-cleanup sweep reads
`workers.last_heartbeat_at` and reclaims jobs held by any worker that has gone stale — see
`DEVELOPMENT.md` for why that sweep lives in `backend-api` and not `worker-service`.

## Job lifecycle: Enqueued -> Dead Letter Queue

```
POST /api/projects/:projectId/jobs
                |
                v
+---------------------------------------------------------------+
|  ENQUEUED                                                        |
|   immediate -> status='queued',    run_at = now()                |
|   delayed   -> status='scheduled', run_at = <future timestamp>   |
|   recurring -> status='scheduled', run_at = first cron occurrence;|
|                cron_expression persisted as the baseline rule     |
+---------------------------------+-------------------------------+
                                   |
                                   |  worker poll loop (worker-service/src/claim.ts):
                                   |  SELECT ... WHERE status IN ('queued','scheduled')
                                   |    AND run_at <= now() AND queues.is_paused = false
                                   |  FOR UPDATE SKIP LOCKED
                                   v
+---------------------------------------------------------------+
|  CLAIMED   status='claimed', claimed_by=<worker id>, claimed_at   |
+---------------------------------+-------------------------------+
                                   |  execute.ts: INSERT job_executions (attempt N, 'running')
                                   v
+---------------------------------------------------------------+
|  RUNNING   status='running', started_at set                       |
+---------------------+-------------------------------------------+
                       |
          succeeds     |     throws
       +---------------+---------------+
       v                               v
+-----------------------+   +--------------------------------+
|  COMPLETED               |   |  attempts < max_attempts ?        |
|  status='completed'      |   +----------------+-----------------+
|  job_executions:         |                    | yes          | no
|    status='success'      |                    v              v
|                          |   +------------------------+  +---------------------------+
|  if cron_expression set: |   |  back to ENQUEUED         |  |  FAILED                      |
|  atomically insert the   |   |  status='queued'          |  |  status='failed'             |
|  NEXT occurrence as a    |   |  run_at = now + backoff(   |  |  + INSERT dead_letter_queue   |
|  new row, same           |   |  strategy, attempt) --     |  |    row: payload snapshot,      |
|  transaction as the      |   |  fixed / linear /          |  |    fail_reason, attempts        |
|  completion update       |   |  exponential                |  |  -- isolated from the live      |
+-----------------------+   +------------------------+  |    jobs table for triage         |
                                                          +---------------------------+
```

**Safety net, from any `claimed`/`running` state:** if a worker misses
`WORKER_HEARTBEAT_TIMEOUT_MS`, `backend-api`'s zombie-cleanup sweep marks it `offline` and
force-requeues its jobs — `status='queued'`, `claimed_by=NULL`, `run_at=now()`, attempts left
untouched (this is an infra failure, not a job failure). See `DEVELOPMENT.md` for the full design
trace on how this, queue pausing, and cron chaining all interact at the database level.

## Data model

`Organization` → `Project` → `Queue` → `Job` is the tenancy/ownership chain; the rest hang off
`Job` and `Worker`. Full column-level detail (types, indexes, cascade behavior) is in
`packages/db/src/schema.ts`, which is the source of truth this list mirrors:

```
Organization   1---* Project              (projects.organization_id)
Organization   1---* OrganizationMember  *---1  User   (RBAC join table)
Project        1---* Queue                (queues.project_id)
Queue          1---* Job                  (jobs.queue_id)
Job            1---* JobExecution         (job_executions.job_id)
Job            1---* JobLog               (job_logs.job_id)
JobExecution   1---* JobLog               (job_logs.execution_id, nullable)
Job            1---1 DeadLetterQueue      (dead_letter_queue.job_id, unique: a job dead-letters once)
Worker         1---* Job                  (jobs.claimed_by, nullable)
Worker         1---* JobExecution         (job_executions.worker_id, nullable)
```

## Setup

1. `npm install` at the repo root (installs all workspaces).
2. Provision a Postgres database and set `DATABASE_URL` in `backend-api/.env` and
   `worker-service/.env` (copy from the respective `.env.example`).
3. `npm run db:generate -w packages/db` then `npm run db:migrate -w packages/db` to create the schema.
4. `npm run dev:api` and `npm run dev:worker` (separate terminals) to run the API and a worker.
5. Copy `frontend-dashboard/.env.example` to `.env` (sets `VITE_API_BASE_URL`), then
   `npm run dev:frontend` and open the printed localhost URL. On first load you'll land on a
   sign-up screen — creating an account also creates an organization, a default project, and a
   default queue for you in one step, so there's nothing to manually configure before the
   dashboard shows live data.

## Multi-tenancy model

`Organization` → `Project` (many) → `Queue` (many) → `Job` (many). Every `/api/projects/:projectId`
request is checked against the authenticated caller's `organizationId`: a project that exists but
belongs to a different organization returns `403`; one that doesn't exist returns `404`. Queues and
jobs are always reached through their parent project — a `queueId` belonging to another project
returns `404` rather than leaking its existence.

## Authentication

Requests must carry `Authorization: Bearer <jwt>`, where the JWT payload is
`{ userId, organizationId }` signed with `JWT_SECRET`. Get a token via:

- `POST /api/auth/signup` — `{ email, password, organizationName, name? }`. Creates a `User`, an
  `Organization` owned by them, a `Default Project`, and a `default` `Queue`, all in one
  transaction, then returns `{ token, user, organization, project }`. `409 email_taken` if the
  email is already registered.
- `POST /api/auth/login` — `{ email, password }`. Verifies the bcrypt hash and returns the same
  shape, using the caller's first (oldest) organization membership. `401 invalid_credentials` on
  any mismatch (never reveals which part was wrong).
- `GET /api/auth/me` — requires a valid `Bearer` token; returns `{ user, organization, project }`
  for session rehydration (`frontend-dashboard` calls this once on load to validate a stored
  token before trusting it).

`frontend-dashboard` uses this flow directly — see "Frontend dashboard" below.

For local scripting/testing without going through signup, `backend-api/.env` also supports
`MOCK_AUTH=true`, which accepts `x-mock-user-id` / `x-mock-organization-id` headers instead of a
JWT for any *existing* organization id. **Never set this in a deployed environment** — it lets
anyone who knows an organization's id act as that org.

## API

All responses are JSON. Errors use a structured shape:

```json
{ "error": { "code": "queue_not_found", "message": "Queue ... not found in this project", "details": null } }
```

### `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/me`

Public (no token required for signup/login). Full request/response shapes are in "Authentication"
above. Every endpoint below this point requires `Authorization: Bearer <jwt>` from one of these.

### `POST /api/projects/:projectId/jobs`

Enqueues a job. `type` is the job *handler* name (e.g. `"send-welcome-email"`) — kept independent
of `schedule.mode`, which only controls when the job first becomes eligible for claiming. This
separation is what lets a future handler registry dispatch on `type` without touching scheduling.

```jsonc
// request body
{
  "type": "send-welcome-email",
  "queueId": "3fa2...uuid",
  "payload": { "userId": "123" },        // optional, default {}
  "priority": 0,                          // optional, default 0, higher claims first
  "maxAttempts": 3,                       // optional, default 3
  "schedule": {                           // optional, default { "mode": "immediate" }
    "mode": "immediate"
  }
}
```

`schedule` supports three modes:

| mode        | extra fields                    | resulting `run_at`              | initial `status` |
|-------------|----------------------------------|----------------------------------|-------------------|
| `immediate` | —                                | now                               | `queued`          |
| `delayed`   | `runAt` (ISO date, must be future) | `runAt`                        | `scheduled`       |
| `recurring` | `cronExpression` (standard cron)   | first computed occurrence      | `scheduled`       |

For `recurring`, the cron expression is parsed with `cron-parser` and persisted on the job row as
the baseline rule. This endpoint schedules only the **first** occurrence; `worker-service` chains
every occurrence after that itself — see `DEVELOPMENT.md` for the mechanism.

Response: `201 { "data": <job row> }`. `404 queue_not_found` if `queueId` isn't in this project.
`400 run_at_in_past` if a delayed `runAt` isn't in the future. `400 invalid_cron_expression` if the
cron string doesn't parse.

### `GET /api/projects/:projectId/jobs`

Paginated, filterable job search, scoped to the project.

Query params: `page` (default 1), `pageSize` (default 20, max 100), `queueId?`, `status?` (one of
`queued`/`scheduled`/`claimed`/`running`/`completed`/`failed`), `from?`/`to?` (ISO dates, filter on
`createdAt`).

```json
{
  "data": [ /* job rows */ ],
  "pagination": { "page": 1, "pageSize": 20, "total": 143, "totalPages": 8 }
}
```

### `POST /api/projects/:projectId/queues/:queueId/pause`

Sets `queues.is_paused = true`. Jobs already `claimed`/`running` are unaffected — this only stops
*new* claims. Takes effect on the worker's very next poll cycle (see the design trace in
`DEVELOPMENT.md`). Response: `200 { "data": <queue row> }`.

### `POST /api/projects/:projectId/queues/:queueId/resume`

Clears `is_paused`. Same response shape as pause.

### `GET /api/projects/:projectId/queues`

Lists the project's queues (config + `isPaused`), ordered by priority descending. Backs the
dashboard's Queue Configuration Matrix. Response: `200 { "data": <queue row>[] }`.

### `GET /api/projects/:projectId/jobs/:jobId/logs`

Full `job_logs` trace for one job, oldest first — the Job Explorer's slide-out detail panel.
`404 job_not_found` if the job isn't in this project. Response: `200 { "data": <job_log row>[] }`.

### `GET /api/projects/:projectId/metrics`

One aggregate read for dashboard tiles/charts instead of the frontend firing a paginated `GET
/jobs` call per status: job counts by status plus the dead-letter total.

```json
{
  "data": {
    "queueCount": 3,
    "jobCounts": { "queued": 2, "scheduled": 1, "claimed": 0, "running": 1, "completed": 40, "failed": 3 },
    "deadLetterCount": 3
  }
}
```

### `GET /api/workers`

Fleet-wide worker roster (id, hostname, pid, status, lastHeartbeatAt). **Not** scoped to
`:projectId` — the `workers` table has no tenant column (see DEVELOPMENT.md): a single worker
process polls and claims across any org/project's queues, so "this project's workers" isn't a
concept the schema supports. Response: `200 { "data": <worker row>[] }`.

## Frontend dashboard

`frontend-dashboard/` is a Vite + React 19 + TypeScript + Tailwind CSS v4 SPA (`recharts` for
charts), talking to `backend-api` over the REST API above via real `Authorization: Bearer` auth —
no server-side rendering, no separate backend-for-frontend.

- **Auth**: `src/components/AuthScreen.tsx` (login/signup toggle) + `src/hooks/useAuth.ts` +
  `src/auth.ts` (session storage). Signing up calls `POST /api/auth/signup` and stores the
  returned `{ token, user, organization, project }` in `localStorage`; every subsequent API call
  sends `Authorization: Bearer <token>` (`src/api/client.ts`). On load, a stored token is validated
  against `GET /api/auth/me` before being trusted — an expired or revoked token drops back to the
  login screen instead of silently showing broken data.
- **Design tokens** live in `src/index.css` as a Tailwind v4 `@theme` block: `sand` (canvas),
  `olive`/`olive-dark` (brand/primary actions), `sage` (secondary highlight), `terracotta`/
  `terracotta-light` (alerts, dead-letter counts). Glass tiles are a shared `<GlassCard>` component
  (`bg-white/70 backdrop-blur-md border border-white/40`, diffuse shadow) rather than a duplicated
  className string.
- **Layout**: `Layout.tsx` + `Sidebar.tsx` — a static left sidebar on desktop (`md:` and up), a
  slide-in drawer behind a hamburger button below that breakpoint. Content grids collapse from
  3/2 columns down to 1 via Tailwind's responsive column classes, no separate mobile markup.
- **Pages** (`src/App.tsx`, tab-based, no router — three tabs don't need one): **Overview**
  (`ClusterHealth` + `ThroughputChart`), **Queues** (`QueueMatrix`, pause/resume wired to the
  endpoints above), **Jobs** (`JobExplorer` + `JobDetailPanel` slide-out).
- **Data fetching**: a small custom `usePolling` hook (5s for queues/workers/metrics, 4s for the
  job grid) — no React Query/SWR dependency, since three polled resources didn't justify one.
- **Chart palette**: the throughput chart does *not* use the brand's exact
  `#C0CFC0`/`#E5CEC6`/`#DDA28F` — those read as near-gray and fail CVD-safety at the hex level (see
  DEVELOPMENT.md). It uses deepened variants of the same three hue families instead, validated with
  the dataviz skill's palette checker.
- Env: `VITE_API_BASE_URL` (see `.env.example`). Scripts: `npm run dev:frontend` (root) or
  `dev`/`build`/`preview`/`typecheck` inside `frontend-dashboard/`.

## Deployment

- **Neon (Postgres)**: create a project, copy the **direct** (non-`-pooler`) connection string —
  see `DEVELOPMENT.md` for why pooled connections are unsafe here — and run migrations once against
  it: `DATABASE_URL=<neon-connection-string> npm run db:migrate -w packages/db`.
- **Render**, two services from this repo (both need the repo root as the build context, since npm
  workspaces requires the root install):
  - `backend-api` — Web Service. Build: `npm install && npm run build -w backend-api`. Start:
    `npm run start -w backend-api`.
  - `worker-service` — Background Worker. Build: `npm install && npm run build -w worker-service`.
    Start: `npm run start -w worker-service`. Scale out by increasing instance count — each instance
    registers as its own `workers` row and claims independently; no extra config needed.
- **Vercel**: `frontend-dashboard`, with Root Directory set to `frontend-dashboard`. Vercel
  auto-detects the Vite build (`vite build`, output `dist`); the repo's root `package-lock.json`
  lets it install the whole workspace so nothing resolves incorrectly.

### Environment variables

| Service | Platform | Variable | Required | Notes |
|---|---|---|---|---|
| `backend-api` | Render | `DATABASE_URL` | yes | Neon **direct** connection string |
| `backend-api` | Render | `PORT` | no | Render injects this itself |
| `backend-api` | Render | `JWT_SECRET` | yes | generate with `openssl rand -base64 48` |
| `backend-api` | Render | `MOCK_AUTH` | no | **omit entirely** — never set in production |
| `backend-api` | Render | `WORKER_HEARTBEAT_TIMEOUT_MS` | no | default `15000` |
| `backend-api` | Render | `ZOMBIE_CLEANUP_INTERVAL_MS` | no | default `10000` |
| `worker-service` | Render | `DATABASE_URL` | yes | same Neon direct string |
| `worker-service` | Render | `POLL_INTERVAL_MS` | no | default `1000` |
| `worker-service` | Render | `HEARTBEAT_INTERVAL_MS` | no | default `5000` |
| `worker-service` | Render | `MAX_CLAIM_PER_QUEUE` | no | default `5` |
| `frontend-dashboard` | Vercel | `VITE_API_BASE_URL` | yes | Render `backend-api` URL + `/api` |

Each service's `.env.example` carries the same guidance inline.

## Documentation

- Architecture diagram — see "System architecture" above
- Job lifecycle diagram — see "Job lifecycle" above
- ER overview — see "Data model" above (column-level detail: `packages/db/src/schema.ts`)
- Design decisions & trade-offs — see `DEVELOPMENT.md`
