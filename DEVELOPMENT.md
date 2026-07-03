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
