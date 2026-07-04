# Development & Design Decisions

## Workspace layout

npm workspaces monorepo:

- `backend-api`, `worker-service`, `frontend-dashboard` — deployable services
- `packages/db` — shared Drizzle ORM schema + client, consumed by `backend-api` and `worker-service`
  as a workspace dependency so both talk to the database through one schema definition instead of
  drifting copies.

## System design & trade-offs: `FOR UPDATE SKIP LOCKED` vs. a Redis-backed queue

The core problem every job scheduler has to solve is the same one this project solves in
`worker-service/src/claim.ts`: **N concurrent workers must agree on who owns a job, with zero
double-claims and zero lost jobs.** There are two mainstream ways to get there. This project uses
the first; it's worth being explicit about what that traded away.

**Option A — Postgres, `SELECT ... FOR UPDATE SKIP LOCKED` (what this project does).** A worker
opens a transaction, selects due rows with `FOR UPDATE SKIP LOCKED` (so a row another transaction
already has locked is silently skipped, never waited on), flips their status, and commits. The
job table is a normal table in the same database as `Users`/`Projects`/`Queues`.

**Option B — Redis-backed queue (BullMQ, Sidekiq, RSMQ, etc.).** Jobs live in Redis data structures
(lists, sorted sets for delays/priority, streams). A dispatcher pops/reserves work atomically via
Redis's own single-threaded command execution or Lua scripts, and a separate worker process
executes it. Job state lives entirely outside the relational database.

| Dimension | Postgres `SKIP LOCKED` (this project) | Redis-backed queue |
|---|---|---|
| **Durability** | Jobs live in the same ACID, WAL-logged store as the rest of the app's data. Point-in-time recovery and `pg_dump` back up the entire job history for free. | Depends on Redis persistence config (RDB snapshot / AOF). A misconfigured or memory-evicted Redis can silently lose queued jobs. |
| **Consistency with business data** | A job's completion and a business-side effect (e.g., "mark invoice paid") can share one Postgres transaction — see how `execute.ts` commits the completion update, the log write, and cron-chaining as one unit. | Job state and business data live in different stores; keeping them consistent needs an outbox pattern or careful dual-write discipline. |
| **Operational footprint** | One datastore to run, back up, monitor, and pay for — already needed for `Users`/`Projects`/`Queues`. | A second stateful service to provision, size memory for, and keep highly available alongside Postgres. |
| **Throughput ceiling** | Bound by row-locking and connection limits on the primary; comfortably handles thousands of claims/sec, but every claim is a real transaction against the primary DB. | In-memory, built for this exact access pattern; sustains far higher claim throughput and lower per-claim latency at the extreme end. |
| **Horizontal scaling** | Scales with Postgres — read replicas don't help writes; sharding queues across primaries is possible (the schema's `queue_id` is already a natural partition key) but not something we built. | Redis Cluster / multiple queue instances shard more naturally; most Redis queue libraries assume this from day one. |
| **Feature surface** | Whatever SQL (and our own schema) can express — priorities, delays, retries, DLQ, and cron chaining are all hand-built here on relational tables. | Mature ecosystems ship priority queues, rate limiting, repeatable jobs, and admin UIs out of the box. |
| **Dispatch latency** | Poll-based, bounded by `POLL_INTERVAL_MS` (currently ~1s); could go event-driven via Postgres `LISTEN`/`NOTIFY` to cut worst-case latency without adding a broker. | Typically push-based (`BRPOPLPUSH` / streams) — near-zero dispatch latency. |
| **Incremental cost at this project's scale** | Zero — reuses the Postgres instance already required for the relational schema. | An additional managed Redis instance (Upstash, ElastiCache, etc.) with its own bill and failure domain. |

**Why Postgres was the right call here:** this project already needed a real relational schema for
`Users`/`Organizations`/`Projects`/`Queues`/`JobExecutions`/`JobLogs`/`DeadLetterQueue` with foreign
keys between them — a job's current state and its full execution history are one join away. Adding
`SKIP LOCKED` claiming to that same store costs zero new infrastructure and inherits Postgres's
durability and backup story for free. At this project's expected scale (a handful of worker
replicas, human-triggered job volumes, not a high-frequency trading pipeline), Postgres's throughput
ceiling is nowhere near the binding constraint, so the operational simplicity of *one* datastore
outweighs Redis's raw throughput and latency advantage.

**When Redis (or a managed queue like SQS) would be the better call instead:** throughput
requirements in the tens of thousands of claims/sec sustained; dispatch latency in the
low-single-digit milliseconds is a hard requirement; the team already runs Redis for
caching/sessions and would rather isolate a write-heavy queue workload from the primary Postgres
instance entirely; or the job payloads are large/ephemeral enough that they don't belong in a
relational store's row storage at all.

**A concrete deployment consequence of this choice**, documented in each service's `.env.example`:
Neon's *pooled* (PgBouncer transaction-mode) connection string is unsafe for this project's Postgres
client, because `postgres-js` issues prepared statements and holds multi-statement transactions —
both assume a stable connection for their duration, which transaction-mode pooling doesn't guarantee.
This is exactly the kind of coupling a Redis-backed design wouldn't have (Redis clients don't share
this failure mode) — the price of putting the queue in the same database as everything else.

## Design decisions log

- **Schema renormalization: `retry_policies`, `worker_heartbeats`, `scheduled_jobs` split out from
  `queues`/`workers`/`jobs`.** The brief names these as their own entities; they'd been collapsed
  into columns for simplicity. The migration (`packages/db/drizzle/0001_past_vanisher.sql`,
  hand-edited after `drizzle-kit generate`) backfills each before dropping the old columns —
  `retry_policies` from every existing queue's retry columns, `worker_heartbeats` from each
  worker's last known heartbeat, and `scheduled_jobs` by grouping existing recurring jobs on
  `(queue_id, type, cron_expression)` so a chained series collapses to *one* rule row, not one per
  occurrence (the chaining logic had been copying `cron_expression` onto every child job, so a
  naive per-row backfill would have manufactured a duplicate rule per occurrence). Verified against
  a live local database with real pre-existing data before this was considered safe to write up
  as "done" — see the migration's own history in this log for what a plain `drizzle-kit generate`
  gets wrong by default (no data backfill at all).
- **`jobs.status`/`run_at`/`queue_id` and their composite index were left untouched.** The brief
  asked to isolate scheduled_jobs "away from the core hot operational data table" — the *rule*
  (cron expression, payload template) moved out via `jobs.scheduled_job_id`, but the columns
  `claim.ts`'s `SELECT ... FOR UPDATE SKIP LOCKED` actually filters and sorts on could not move
  without invalidating `jobs_queue_id_status_run_at_idx`, the one index this project is built
  around. Normalizing the rule away from the hot path and keeping the hot path's own columns in
  place are the same goal, not in tension.
- **`worker_heartbeats` is genuinely insert-only, not a column with a JOIN dressed up as one.**
  Considered keeping a denormalized `workers.last_heartbeat_at` fast-path column alongside the new
  history table (cheaper zombie-sweep queries), but at this project's worker-fleet scale a `GROUP
  BY worker_id` over the full history is not a real cost, and keeping both would mean two sources
  of truth that could drift. `GET /workers` and the zombie sweep both compute "latest heartbeat"
  live. Known trade-off, not fixed here: this table grows unbounded (1 row per worker per
  `HEARTBEAT_INTERVAL_MS`) — a retention job is the natural next step.
- **The manual retry endpoint stayed at `/api/projects/:projectId/jobs/:jobId/retry`, not the bare
  `/api/jobs/:jobId/retry` the brief described.** Every other job route is tenant-scoped through
  `requireProjectAccess`; a bare `/api/jobs/:jobId/retry` would need its own ad hoc
  ownership check to avoid one org retrying another's job, duplicating logic that already exists
  and is already tested. Consistency with the rest of the API won over matching the literal path.
- **Two more gotchas from the same family as `bcryptjs` and `cron-parser` earlier in this log**:
  `pino-http`'s default export isn't callable under this project's module resolution (its `.d.ts`
  also exports a named `pinoHttp`, which is — same fix pattern, different package) — caught by
  `tsc`, not by running anything. More seriously, **Vitest silently double-ran every test** because
  `npm run build` compiles `src/__tests__` into `dist/__tests__` (test files aren't excluded from
  the `tsc` build, since `typecheck` needs to still cover them), and Vitest picked up both the
  `.ts` source and the compiled `.js` sitting in a stale `dist/` from an earlier build. Fixed with
  an explicit `exclude: ["**/dist/**"]` in both `vitest.config.ts` files. Caught by noticing the
  reported test count (4, then 8) didn't match the number of `it(...)` blocks actually written —
  a reminder that a passing count is only informative if you know what count to expect.
- **`backend-api` had zero CORS configuration until the Vercel↔Render deploy actually surfaced
  it.** The frontend and backend running on different origins (a `vercel.app` domain calling an
  `onrender.com` domain) is a textbook cross-origin request, which browsers block by default absent
  `Access-Control-Allow-Origin` response headers. This gap survived every prior check in this
  project because none of them involved a real browser making a cross-origin request: local dev's
  frontend/backend are technically cross-origin too (different ports), but verification there used
  `curl` against the Vite dev server, and `curl` doesn't enforce same-origin policy — only browsers
  do. Fix: the `cors` package, gated to an explicit `CORS_ORIGIN` allowlist (comma-separated) rather
  than a wildcard — auth here is Bearer-token, not cookies, so a wildcard wouldn't itself leak
  credentials cross-origin, but pinning to known origins is still the safer default. Verified with
  `curl -H "Origin: ..."` against three cases: an allowed origin's preflight `OPTIONS` (204, correct
  `Access-Control-Allow-Methods`/`Allow-Headers`), an allowed origin's actual request (response
  carries `Access-Control-Allow-Origin`, so a browser would let JS read it), and a non-allowlisted
  origin's request (response omits that header, so a browser would block JS from reading it) — `curl`
  itself doesn't enforce CORS, but this confirms the server sends the headers a browser needs to
  either allow or block correctly. The general lesson stacks on the `packages/db` build gap and the
  `bcryptjs` import gap from earlier in this log: **each was invisible to every check that didn't
  exercise the exact real-world path** (compiled output run by plain `node`; a real cross-origin
  browser request) **that production actually takes.**
- **`worker-service` has two entrypoints: a continuous poll loop (`src/index.ts`) and a
  one-shot sweep-until-empty-then-exit mode (`src/runOnce.ts`), sharing all their claim/execute
  logic via `src/sweep.ts`.** Forced by a real constraint, not preference: Render's Background
  Worker service type (needed for a continuously-running poll loop) has no free tier — Starter is
  $7/mo minimum. `runOnce.ts` registers a worker, calls `runSweep()` in a loop until a pass claims
  nothing or a `MAX_RUN_MS` wall-clock budget expires (a schedule firing every few minutes can find
  several minutes' worth of due jobs backed up, not just what arrived since the last tick), drains
  whatever it claimed, marks itself offline, exits — reusing `claim.ts`/`execute.ts`/`heartbeat.ts`
  unchanged. The trade-off is job pickup latency: continuous polling is bounded by
  `POLL_INTERVAL_MS` (~1s); one-shot mode is bounded by however often it's triggered. Verified by
  running the compiled `dist/runOnce.js` directly with plain `node` (not `tsx`) against a live
  database: a 3-job run and an 8-job run against a `concurrencyLimit` of 4 (forcing multiple sweep
  passes within one invocation) both completed correctly and exited 0; a zero-jobs run exited in
  ~0.2s. Both entrypoints remain available — `npm start` for a paid, always-on Background Worker
  with lower latency; `npm run start:once` for a scheduled-trigger deployment.
- **The scheduled trigger for `runOnce.ts` ended up being GitHub Actions, not a Render Cron
  Job.** Render Cron Jobs looked free at a glance ("runs a command on a schedule, no idle cost")
  but actually bill per second of compute used per run — small, but not the zero this project's
  deployment target needed. GitHub Actions' scheduled workflows are free with no cost ceiling at
  all on a public repo (2,000 min/month even on a private one). `.github/workflows/worker-cron.yml`
  runs every 5 minutes (`workflow_dispatch` also enabled for manual runs), checks out the repo,
  builds `packages/db` and `worker-service` fresh each run (GitHub-hosted runners are ephemeral, no
  persistent `dist/` between runs), and runs the exact same `runOnce.js`. `concurrency:
  cancel-in-progress: false` queues rather than kills a run if one is still going when the next
  tick fires, though this is belt-and-suspenders — `claim.ts`'s `SKIP LOCKED` already makes
  concurrent invocations safe at the database level regardless. Verified by running the workflow's
  exact command sequence locally (`npm ci`, both builds, `node dist/runOnce.js`) before ever
  pushing it. This left Render hosting only `backend-api`, whose free Web Service tier (with
  cold-start spin-down after inactivity) was an acceptable trade-off the user didn't push back on.
- **`packages/db` builds to `dist/`; its `package.json` `main`/`types` point there, not at
  `src/`.** This was a real production outage, not a hypothetical: a real Render deploy of
  `backend-api` failed with `ERR_MODULE_NOT_FOUND: .../packages/db/src/schema.js` because
  `main`/`types` originally pointed straight at `./src/index.ts`. That "worked" in every check run
  before the actual deploy — local dev (`tsx watch` transpiles the whole module graph on the fly,
  including workspace packages), `tsc --noEmit` (TypeScript is perfectly happy reading a `.ts` file
  as another package's type source) — because every one of those tools has a TypeScript-aware
  layer in front of Node's module resolution. Plain `node dist/index.js`, what both services
  actually run in production, does not: it resolves `@scheduler/db` via `package.json`, finds
  `./src/index.ts`, and chokes on that file's `export * from "./schema.js"` since no `schema.js`
  exists next to the `.ts` source. Fix: `packages/db` gets a real `build` script
  (`tsc -p tsconfig.json`), `main`/`types` point at `./dist/index.js`/`./dist/index.d.ts`, and the
  root `package.json`'s `dev:api`/`dev:worker`/`build:api`/`build:worker` scripts all build
  `packages/db` first. Verified by literally running `node backend-api/dist/index.js` directly
  (not through any dev tool) both before the fix (reproduced the exact Render error locally) and
  after (clean start, `/health` responds). The lesson generalizes: **`tsc --noEmit` passing is not
  evidence that compiled output runs** — it only proves the source typechecks, not that plain
  `node` can execute what gets emitted. This gap existed silently from Phase 1 through every build
  verification in this document until an actual deploy caught it.
- **Atomic claim via `SELECT ... FOR UPDATE SKIP LOCKED`** (`worker-service/src/claim.ts`): concurrent
  workers polling the same queue never block on or duplicate-claim a row — a locked row is skipped,
  not waited on. The claiming `UPDATE` runs in the same transaction as the lock, so a row is never
  visible as claimable again until the transaction that claimed it commits.
- **Per-queue `concurrencyLimit` enforced fleet-wide, not per-process**: `getInFlightCount` counts
  `claimed`+`running` rows across *all* workers before a worker claims more, so the limit is a real
  distributed cap, not one limit per worker process.
- **`jobs.status = 'scheduled'` vs `'queued'`**: both are claimable once `run_at <= now()` (see
  `claim.ts`'s `inArray(jobs.status, ["queued","scheduled"])`). `scheduled` exists purely so the API
  and dashboard can distinguish "not due yet" from "due now, waiting for a worker" — there's no
  separate promotion step flipping `scheduled` → `queued`; the claim query's `run_at` filter does
  that work implicitly.
- **Zombie cleanup runs in `backend-api`, not `worker-service`**: a worker can't detect its own
  crash. A separate process sweeping stale heartbeats is the only reliable way to reclaim jobs held
  by a worker that died mid-execution.
- **Auth is JWT-first with a `MOCK_AUTH` dev fallback**: there's no signup/login endpoint yet, so
  requiring a real JWT would make the API untestable locally. The fallback is header-based and
  explicitly gated behind an env flag documented as dev-only in the README.
- **Multi-tenant scoping resolves `:projectId` once, centrally** (`requireProjectAccess`
  middleware), rather than re-checking organization ownership in every route handler — one place to
  get tenant isolation right, instead of N places that can drift.
- **Success/failure execution outcomes are transactional** (`worker-service/src/execute.ts`): the
  `job_executions` update, the `jobs` status update, and (on success) the cron-chain insert all
  commit as one unit. A crash between "marked complete" and "next occurrence inserted" can no longer
  silently kill a recurring series.
- **`GET /api/workers` is fleet-wide, not `/projects/:projectId/workers`**: the `workers` table has
  no tenant column — a worker process claims across any org/project's queues by design (shared
  execution infrastructure, not a per-tenant resource, matching how e.g. Sidekiq or SQS consumers
  work). Scoping it by project would imply an isolation guarantee the schema doesn't provide;
  exposing the honest shape was better than faking a boundary.
- **Chart palette deviates from the brand's exact hex codes.** `#C0CFC0` / `#E5CEC6` / `#DDA28F` at
  full brand lightness read as near-gray (chroma 0.026–0.076, below the "reads as a real color"
  floor) and two of them are nearly indistinguishable under protanopia (ΔE 1.9 — a hard CVD-safety
  failure, not a borderline one). Validated with the dataviz skill's `validate_palette.js` script.
  Fix: deepened variants in the same three hue families (`#398048` sage-green / `#C97B4A`
  terracotta / `#33578F` slate) pass lightness, chroma, and contrast; CVD separation lands in the
  8–12 floor band, so the chart ships direct value labels + a legend rather than color-only
  encoding. The brand's original soft tones are used everywhere else (buttons, badges, backgrounds)
  exactly as specified — only the data-encoding chart fill was adjusted.
- **Frontend has no router and no React Query/SWR.** Three tabs (Overview/Queues/Jobs) are plain
  `useState`, not routes — a router earns its keep with deep-linkable or nested views, neither of
  which apply yet. Similarly, three polled resources (queues, workers, metrics) didn't justify a data
  library; a ~30-line `usePolling` hook covers refetch-on-interval plus manual refetch after a
  mutation (e.g. right after pause/resume).
- **Signup creates a whole default workspace, not just a user.** `POST /api/auth/signup`
  (`backend-api/src/routes/auth.ts`) inserts `User` + `Organization` + `OrganizationMember(owner)` +
  a `Default Project` + a `default` `Queue` in one transaction. The alternative — signup only
  creates a user, with separate "create your organization" / "create your first project" steps —
  is more correct long-term (a user might want multiple projects, or to join an existing org
  instead), but would have meant either building project/queue CRUD endpoints just to get a fresh
  signup to a usable screen, or leaving the dashboard blank after signup with a "now go create a
  project via curl" instruction. One transaction that lands somewhere usable won out for this
  scope; multi-project-per-org and org-invite flows are the natural next increment.
- **`bcryptjs`'s named exports don't survive Node's CJS→ESM interop.** `import { hash, compare }
  from "bcryptjs"` type-checks (its `.d.ts` declares named exports) but fails at runtime —
  `SyntaxError: The requested module 'bcryptjs' does not provide an export named 'compare'` —
  because its actual `module.exports = require("./dist/bcrypt.js")` re-export pattern isn't
  something `cjs-module-lexer` can statically analyze. Same class of issue flagged for
  `cron-parser` back in Phase 3; the fix is the same: `import bcrypt from "bcryptjs"` (default
  import always works, since it just grabs whatever `module.exports` is) and call
  `bcrypt.hash(...)` / `bcrypt.compare(...)`. Caught by actually running signup against a live
  database rather than trusting `tsc --noEmit`, which had already passed.
- **Project/queue CRUD**, closing the gap called out above ("multi-project-per-org... is the
  natural next increment"). `POST /api/projects` and `POST /api/projects/:projectId/queues` let an
  org grow past the one project/one queue signup creates; `PATCH` on both lets `priority`/
  `concurrencyLimit`/`retryPolicy` (previously frozen after creation) and a project's `name` be
  changed later. Kept structurally identical to every existing route: same `requireProjectAccess`
  tenant check, same `validate()`/`ApiError` conventions, queue creation still transactionally
  pairs a `queues` row with its 1:1 `retry_policies` row exactly like signup does. Verified live
  against a real local Neon-shaped Postgres: created a second project and a second queue, updated
  the queue's retry policy, confirmed `GET /queues` reflected the change, then exercised the same
  flow through the actual dashboard UI (Playwright-driven) before considering it done.
- **RBAC enforcement, not just the schema.** `organization_members.role` existed from Phase 1 but
  nothing read it — any authenticated member could do anything in their org. `requireRole(...)`
  (`backend-api/src/middleware/rbac.ts`) looks the role up per-request and gates *structural*
  changes (project/queue create, rename, delete, config update) to `owner`/`admin`, leaving
  *operational* actions (pause/resume, enqueue, batch-create, retry) open to every role — an
  on-call `member` shouldn't need `admin` just to pause a misbehaving queue during an incident.
  Testing this hit the same asyncHandler gotcha the route layer relies on in production:
  `asyncHandler`'s wrapper (`fn(req, res, next).catch(next)`) doesn't return the inner promise, so
  `await requireRole(...)(req, res, next)` in a test resolves before the async DB lookup or `next()`
  call ever happens. Fixed in the test, not the middleware (production code is driven by Express's
  own request/response cycle, which never awaits a middleware's return value either) — the test
  instead wraps `next` in a `Promise` that resolves when *it* is called, and awaits that.
- **`delayed` and `scheduled` are two schedule modes, not one.** The brief names both explicitly;
  the original implementation only had `delayed` (absolute `runAt`). Rather than leave `scheduled`
  a no-op alias, `delayed` was redefined as a *relative* offset (`delayMs` — "run in 10 minutes,"
  no timestamp math for the caller) and `scheduled` took over the original *absolute* timestamp
  behavior (`runAt` — "run at 2026-08-01T10:00:00Z"). Both still land the job in
  `status='scheduled'`; only how `run_at` is computed differs. This is a breaking change to the API
  shape of the old `delayed` mode, judged acceptable since nothing in `frontend-dashboard` created
  jobs through a schedule-mode UI to begin with (job creation was API/curl-only) — verified by
  grepping the frontend for `schedule.mode`/`"delayed"` before making the change, which found none.
- **Idempotency key is per-queue, not global, and jobs without one are never deduped.**
  `jobs.idempotency_key` plus a unique index on `(queue_id, idempotency_key)` gives `POST /jobs` a
  cheap way to make retrying a timed-out request safe: same key on the same queue returns the
  existing job (`200`) instead of inserting a duplicate. Chose a DB constraint over an in-memory or
  Redis-backed dedupe cache since Postgres already treats every `NULL` as distinct in a unique
  index — jobs created without a key (the common case) need zero special-casing to avoid colliding
  with each other. The route both pre-checks (avoids a wasted insert attempt on the common
  retry-after-timeout path) and catches the constraint violation (`23505`) around the actual
  insert, since a genuine race between two concurrent requests with the same key can still slip
  past the pre-check — confirmed both paths return the same existing row, not a 409/500, via a live
  `curl` sequence (first call `201`, replayed call `200` with `idempotent: true`, same job `id`
  both times).

- **Added a "Create job" form to the dashboard (`CreateJobModal.tsx`).** Job creation had been
  API/curl-only since Phase 3 — a deliberate scope call at the time (see the request-logging /
  batch-endpoint priority list earlier in this log), but it meant a fresh signup's Job Explorer was
  permanently empty for anyone not calling the API directly, which is exactly the confusion that
  prompted adding this. One form covers all four `schedule` modes (immediate/delayed/scheduled/
  recurring) with conditional fields per mode, a JSON payload textarea (validated client-side
  before submit so a malformed payload never reaches the API), and the optional idempotency key.
  Verified live: created one `immediate` and one `delayed` job through the actual form (Playwright-
  driven, not just typechecked), confirmed both appeared in the Job Explorer with the correct
  `status`/`run_at`.

- **Workflow dependencies: gated in the claim query, not a status/trigger.** `jobs.parent_job_id`
  is a plain self-referencing FK; the actual "wait until parent completed" behavior lives entirely
  in `worker-service/src/claim.ts`'s `SELECT`, via a `LEFT JOIN` against a second alias of `jobs`
  (`parentJobs`) and a `WHERE parent_job_id IS NULL OR parentJobs.status = 'completed'`. Considered
  a Postgres trigger that flips a "ready" flag on the child when its parent completes, but that's a
  second source of truth that could drift from the parent's actual status under a crash between the
  update and the trigger firing — reading the parent's live status at claim time can't drift,
  because there's nothing to keep in sync. The self-join only locks the child row (`FOR UPDATE OF
  jobs`, not `parentJobs`), so this adds zero extra lock contention on parent rows, which are very
  likely still being read/written by their own execution elsewhere. Deliberately does not cascade a
  parent's failure onto its dependents — a dependent whose parent dead-letters instead of completes
  waits indefinitely rather than auto-failing, which is a known, documented trade-off (a cascading-
  failure sweep is the natural next increment, not built here). Verified two ways: the Vitest suite
  (`workflowDependencies.test.ts`) against a real DB, and live end-to-end — created a parent
  designed to always fail (`maxAttempts: 1`, `simulateFailure: true`) and a child depending on it,
  confirmed via `psql` that the child sat at `status='queued'`, `attempts=0` indefinitely while a
  real worker process ran against the same database, never claiming it.

- **Rate limiting is an in-memory token bucket, not Redis.** Nothing else in this stack assumes
  Redis is available (see the SKIP-LOCKED-vs-Redis-queue trade-off earlier in this log), and adding
  it as a hard dependency just for rate limiting felt disproportionate to a project that's
  deliberately run on free-tier everything. The trade-off, stated plainly: this is correct and
  sufficient for Render's single free-tier instance, but under-counts if this API ever scales to
  multiple instances behind a load balancer (each instance enforces the limit independently, so the
  effective ceiling becomes `limit × instanceCount`). Resolution order (queue override → org
  default → a 120/min code-level fallback) means the feature demonstrably works with zero
  configuration — a fresh signup's default queue still gets a real, enforced limit, not just a
  configurable-but-inert column. Verified live: a queue configured to `rateLimitPerMinute: 3`
  returned `201` for the first three `POST /jobs` calls in a burst and `429 rate_limit_exceeded`
  (with a computed `Retry-After`) for the fourth and fifth.

- **Queue sharding's hash space is independent of any one queue's `shardCount`.**
  `jobs.shard_key = hash(id) % 1024` is computed once, at insert time, using a fixed modulus that
  has nothing to do with the owning queue's `shardCount`. The alternative — hashing directly into
  `shardCount` buckets — would mean every existing job's `shard_key` becomes meaningless the moment
  an operator changes that queue's `shardCount`, forcing either a backfill migration or a "shard
  count can never change" rule. Computing modulo a large fixed space and then reducing *that* modulo
  the current `shardCount` at claim time (`shard_key % shard_count = WORKER_SHARD_INDEX`) means
  `shardCount` is freely adjustable at any time with zero data migration — only the claim query's
  filter changes, not any stored row. `jobs.id` is generated client-side (`crypto.randomUUID()`) at
  every insertion call site specifically so the shard key can be computed *before* the row exists,
  rather than needing a round-trip after insert. Verified against a real DB
  (`sharding.test.ts`): four jobs seeded across shards 0-3, a worker pinned to shard 0 claims
  exactly the `shard_key=0` job and nothing else, and the default (`shardCount=1`,
  `WORKER_SHARD_INDEX=0`) reproduces unsharded behavior exactly regardless of a job's `shard_key`.

- **Event-driven execution needed its own, separate connection string — this was not obvious
  going in.** The first instinct was to `LISTEN` on the same `DATABASE_URL` connection everything
  else already uses. That connection is Neon's pooled (`-pooler`) host, routed through PgBouncer in
  transaction-pooling mode — which does not reliably support `LISTEN`/`NOTIFY` at all, since a
  notification requires a persistent session-level connection and PgBouncer in that mode hands
  queries to whichever backend connection happens to be free, not the same one call to call.
  Fix: a distinct, optional `LISTEN_DATABASE_URL` env var pointed at Neon's *direct* (non-pooled)
  connection string, used only by `worker-service/src/listen.ts`'s dedicated single-connection
  `postgres()` client — every other query in the whole project keeps using the pooled connection.
  Left unset by default, which disables the optimization entirely and falls back to pure polling —
  deliberately, since this is framed everywhere in the code and docs as a latency speedup, never a
  correctness requirement, so a deployment that never configures it loses nothing but pickup speed.
  The poll loop races a notification against its normal timeout (`waitForWakeOrTimeout`) rather than
  replacing the timeout outright, so a dropped/missed notification never leaves a job waiting longer
  than one ordinary poll interval. Verified live locally (where Postgres has no pooling proxy at
  all, so `LISTEN_DATABASE_URL` could point at the exact same local database): worker log confirmed
  `listening on Postgres channel "job_available"` on startup, and an immediate job created via the
  API showed up `completed` within about a second.

- **WebSocket updates still poll the database — the socket only removes the frontend's HTTP round
  trip.** `worker-service` is a separate, often-ephemeral process (GitHub Actions runs that start,
  work, and exit every few minutes — not a thread living inside `backend-api`), so there is no
  in-process event `backend-api` could subscribe to for "a job just changed state." `backend-api`'s
  `/ws` endpoint therefore runs the exact same two reads `GET /workers` and `GET /metrics` already
  do, on a `WS_PUSH_INTERVAL_MS` interval, and pushes the result to every connected client scoped to
  their `:projectId`. This is real-time from the *frontend's* perspective (no more waiting up to 5s
  for the next poll tick, no repeated HTTP handshake/header overhead) without needing to invent a
  cross-process event bus that this project's architecture doesn't otherwise call for. Auth is a
  `token` query param rather than a header, since the browser's `WebSocket` constructor has no way
  to set custom headers on the handshake request. `frontend-dashboard`'s `useLiveOverview` hook is
  additive, not a replacement: `App.tsx` keeps its pre-existing `usePolling` calls running
  underneath and only prefers the live snapshot while the socket reports `connected`, so an
  environment that never reaches `/ws` (a proxy that strips upgrade headers, `VITE_WS_BASE_URL`
  misconfigured, the socket mid-reconnect) silently and correctly falls back to the polling data
  that was already there. Verified live: a small Node script opened a real WebSocket against the
  local server with a valid token+projectId and received two `snapshot` frames roughly
  `WS_PUSH_INTERVAL_MS` apart.

- **AI failure summaries: computed outside the transaction, and heuristic-first by design, not as
  a fallback bolted on afterward.** First draft called `summarizeFailure()` from *inside*
  `execute.ts`'s `db.transaction(...)` block that also does the dead-letter insert — caught before
  it shipped: a transaction must never sit open across a network call (the real Claude API path
  can take real wall-clock time), since that holds a scarce pooled connection idle for however long
  that call takes. Fixed by computing the summary before opening the transaction and passing the
  already-resolved string in. Separately, `ANTHROPIC_API_KEY` is optional and the heuristic path is
  not a degraded fallback — this project has stayed zero-cost everywhere else (GitHub Actions
  instead of a paid Render worker, in-memory rate limiting instead of Redis), so a DLQ summary
  requiring a paid API key by default would have been the one inconsistent piece. The heuristic
  (`worker-service/src/failureSummary.ts`) pattern-matches ~10 common failure signatures (timeout,
  connection refused, rate limited, unauthorized/forbidden, validation error, null reference, OOM,
  deadlock) into a specific explanation + mitigation pair, falling back to a generic-but-informative
  message otherwise. Verified live: a job forced to fail via `payload.simulateFailure` dead-lettered
  with a real, correctly-classified heuristic summary in `dead_letter_queue.ai_summary` (confirmed
  via `psql`), with no `ANTHROPIC_API_KEY` set anywhere in the local environment.

## Design trace: queue pausing × cron evaluation at the DB level

These two features never touch each other directly, but they interact through the one query both
ultimately run through: the claim query in `worker-service/src/claim.ts`.

**Pausing.** `queues.is_paused` is a plain boolean. There are two enforcement points:

1. `worker-service`'s poll loop (`index.ts`) lists queues with `WHERE is_paused = false` *before*
   doing any per-queue work — a cheap early filter so a paused queue costs nothing per poll tick
   beyond one row scan.
2. `claim.ts`'s claim query independently joins `queues` and requires `is_paused = false` **inside
   the same transaction** as the `FOR UPDATE SKIP LOCKED` select. This closes a race the first check
   alone can't: the poll loop lists active queues, then does an async `getInFlightCount` query,
   *then* calls `claimJobs` — and an operator's `POST /pause` could land in that gap. Because the
   pause check and the row lock happen in one statement, there is no window where a job claims
   successfully after its queue is marked paused; under read-committed isolation the join simply
   sees whichever `is_paused` value was last committed at the moment the statement runs.

   Pausing is intentionally soft: it only blocks *new* claims. Jobs already `claimed`/`running` when
   the pause lands run to completion — there's no kill switch here, by design.

**Cron evaluation.** `cron-parser` only ever runs at two points, both outside the hot polling path:
once in the `POST /jobs` handler when a recurring job is created (to compute the first occurrence's
`run_at` and persist the raw expression on `jobs.cron_expression`), and — once wired up — once more
in the worker's success path for each subsequent occurrence. The claim query itself never parses
cron; it only ever compares `run_at` and `status`, which is why it stays a plain indexed range scan
instead of evaluating an expression per row per poll tick.

**Where they meet.** `worker-service/src/execute.ts`'s success branch now does exactly that: if
`job.cronExpression` is non-null, it computes the next run from `job.runAt` (not `now()`, so the
cadence stays locked to the original schedule instead of drifting with execution time) and inserts
a fresh row (`status = 'scheduled'`) in the **same transaction** as the completion update, via
`cron-parser` again (`worker-service/src/cron.ts`, a duplicate of the API's helper — small enough
that a shared package felt like more machinery than the ~10 lines warranted). Because that insert
only happens on a *successful execution*, a paused queue automatically stops producing new
occurrences too, with no special-casing required: a paused queue can't claim the current
occurrence, so it never executes, so there's no success event to chain the next one from.
Pause-enforcement and cron-chaining both anchor to the same claim → execute path, so correctness for
one gets correctness for the other for free — confirmed live: a recurring job's parent row completed
and its child appeared in the same poll cycle, `run_at` set to the correct next boundary.

## Final systems trace

End-to-end path of one job through every layer built across Phases 1–4, as verified live against a
throwaway Postgres instance (seeded org/project/queue, real `backend-api` + `worker-service`
processes, no mocks):

1. **Ingestion** — `POST /api/projects/:projectId/jobs` (`backend-api/src/routes/jobs.ts`).
   `requireProjectAccess` resolves and tenant-checks `:projectId`; Zod validates the body; for
   `schedule.mode: "recurring"`, `cron-parser` computes the first occurrence. A row lands in `jobs`
   with `status = 'queued'` or `'scheduled'` and `run_at` set. Verified: immediate/delayed/recurring
   all produce the right `status`/`run_at`; a queue's `max_retries` is inherited when `maxAttempts`
   is omitted (a bug caught exactly this way during Phase 3 verification).
2. **Claim** — `worker-service`'s poll loop (`index.ts`) lists non-paused queues, checks
   `getInFlightCount` against `concurrencyLimit`, then `claim.ts` runs
   `SELECT ... FOR UPDATE SKIP LOCKED` joined to `queues` (re-checking `is_paused` in the same
   transaction) and flips matched rows to `claimed`. Verified: a paused queue's due jobs are left
   untouched across multiple poll cycles; resuming claims them on the very next tick.
3. **Execution** — `execute.ts` marks the job `running`, writes a `job_executions` row and a
   `job_logs` entry, then runs the (currently simulated) task. Success and failure outcomes each
   commit as one transaction: success → `completed` + (if recurring) a chained child row at the next
   cron boundary computed from `job.runAt`; failure → backoff-computed retry requeue, or past
   `maxAttempts` → `failed` + a `dead_letter_queue` row. Verified: forced failures walked through
   fixed-backoff retries into the DLQ with a full `job_logs` trace; a recurring job's completion
   produced exactly one child row with the correct next `run_at` and preserved `cron_expression`.
4. **Fault tolerance** — every 5s the worker updates `workers.last_heartbeat_at`; every 10s
   `backend-api`'s `zombieCleanup` sweep flips workers stale past `WORKER_HEARTBEAT_TIMEOUT_MS` to
   `offline` and requeues whatever they were holding (`status → queued`, `run_at → now()`, attempts
   untouched). Verified: a worker process hard-killed mid-execution had its `running` job reclaimed
   and requeued within one sweep interval.
5. **Observability** — `GET /jobs` (paginated/filterable), `GET /jobs/:jobId/logs`, `GET /queues`,
   `GET /workers` (fleet-wide), and `GET /metrics` (status counts + DLQ total in one query) give the
   dashboard everything it renders without any endpoint doing more than one join beyond its own
   table. Verified: all five returned correct shapes against live seeded/executed data.
6. **Dashboard** — `frontend-dashboard` polls (3)–(5)'s read endpoints every 4–5s and renders Cluster
   Health (worker status + job-state counts), the Throughput chart, the Queue Matrix (pause/resume
   calling back into step 2's enforcement), and the Job Explorer with its log-trace slide-out.
   Verified: `tsc --noEmit` and `vite build` both clean; the dev server serves and every component
   module transforms without error against a live backend. **Not verified**: actual rendered
   layout/styling/responsiveness in a browser — no browser-automation tool was available in this
   environment, so the visual result of the design-token/responsive-layout work is unconfirmed
   beyond "it compiles and the markup is structurally sound."
7. **Auth** — `POST /api/auth/signup` (`backend-api/src/routes/auth.ts`) hashes the password with
   `bcrypt`, then in one transaction creates the `User` + `Organization` + owner
   `OrganizationMember` + a default `Project` + `Queue`, and returns a JWT signed with
   `{ userId, organizationId }`. `frontend-dashboard` stores that token and sends
   `Authorization: Bearer` on every call from then on (`src/api/client.ts`) — no more `x-mock-*`
   headers anywhere in the frontend. Verified live: signup produced a working, immediately usable
   project+queue; a duplicate-email signup correctly 409'd; login with a wrong password 401'd,
   with a correct one round-tripping the same session; the issued token worked unmodified against
   the project-scoped API (`GET /queues`) with zero manual configuration.

## Local development

See "Setup" in `README.md`.
