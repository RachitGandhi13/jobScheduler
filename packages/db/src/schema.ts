import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// --- Enums ---------------------------------------------------------------

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "scheduled",
  "claimed",
  "running",
  "completed",
  "failed",
]);

export const retryStrategyEnum = pgEnum("retry_strategy", [
  "fixed",
  "linear",
  "exponential",
]);

export const workerStatusEnum = pgEnum("worker_status", [
  "idle",
  "busy",
  "offline",
]);

export const executionStatusEnum = pgEnum("execution_status", [
  "running",
  "success",
  "failure",
]);

export const organizationRoleEnum = pgEnum("organization_role", [
  "owner",
  "admin",
  "member",
]);

export const logLevelEnum = pgEnum("log_level", [
  "debug",
  "info",
  "warn",
  "error",
]);

// --- Organizations -----------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull(),
  // Org-wide default for job-ingestion rate limiting (requests/minute).
  // NULL means "use the code-level fallback" (see rateLimit.ts) -- a queue's
  // own rateLimitPerMinute, if set, overrides this.
  rateLimitPerMinute: integer("rate_limit_per_minute"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  slugIdx: uniqueIndex("organizations_slug_idx").on(table.slug),
}));

// --- Users -----------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  emailIdx: uniqueIndex("users_email_idx").on(table.email),
}));

// --- Organization Members (join table, also the RBAC hook) -------------------

export const organizationMembers = pgTable("organization_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: organizationRoleEnum("role").default("member").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgUserIdx: uniqueIndex("organization_members_org_id_user_id_idx").on(table.organizationId, table.userId),
  userIdx: index("organization_members_user_id_idx").on(table.userId),
}));

// --- Projects ----------------------------------------------------------------

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  apiKey: varchar("api_key", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  organizationIdx: index("projects_organization_id_idx").on(table.organizationId),
  ownerIdx: index("projects_owner_id_idx").on(table.ownerId),
  apiKeyIdx: uniqueIndex("projects_api_key_idx").on(table.apiKey),
}));

// --- Queues ------------------------------------------------------------------
// Retry configuration lives in its own table (retryPolicies below), not as
// columns here -- see that table's comment for why.

export const queues = pgTable("queues", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  priority: integer("priority").default(0).notNull(),
  concurrencyLimit: integer("concurrency_limit").default(1).notNull(),
  isPaused: boolean("is_paused").default(false).notNull(),
  // Virtual sub-shard count for this queue (see jobs.shardKey below). 1 means
  // "unsharded" -- every job routes to shard 0, which is also the default a
  // single-worker-group deployment sees regardless of this value.
  shardCount: integer("shard_count").default(1).notNull(),
  // Queue-level override for job-ingestion rate limiting; NULL falls back to
  // the owning organization's rateLimitPerMinute, then the code-level default.
  rateLimitPerMinute: integer("rate_limit_per_minute"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  projectIdx: index("queues_project_id_idx").on(table.projectId),
  projectNameIdx: uniqueIndex("queues_project_id_name_idx").on(table.projectId, table.name),
}));

// --- Retry Policies ------------------------------------------------------------
// 1:1 with a queue (a queue has exactly one active policy). Split out as its
// own table rather than columns on `queues` so a policy has its own identity,
// timestamps, and room to grow (e.g. per-job-type overrides) without
// reshaping the queue row itself.

export const retryPolicies = pgTable("retry_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  queueId: uuid("queue_id").notNull().references(() => queues.id, { onDelete: "cascade" }),
  strategy: retryStrategyEnum("strategy").default("fixed").notNull(),
  maxRetries: integer("max_retries").default(3).notNull(),
  baseDelayMs: integer("base_delay_ms").default(1000).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  queueIdx: uniqueIndex("retry_policies_queue_id_idx").on(table.queueId),
}));

// --- Scheduled Jobs (recurring rule definitions) ------------------------------
// The forward-looking cron *rule* (queue, handler type, payload template,
// cron expression) lives here, isolated from `jobs` -- which stays the hot
// operational table the worker's poll query hits every cycle. Each concrete
// occurrence is still a row in `jobs`, linked back via jobs.scheduled_job_id.

export const scheduledJobs = pgTable("scheduled_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  queueId: uuid("queue_id").notNull().references(() => queues.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 255 }).notNull(),
  payload: jsonb("payload").notNull().default({}),
  priority: integer("priority").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  cronExpression: varchar("cron_expression", { length: 100 }).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  queueIdx: index("scheduled_jobs_queue_id_idx").on(table.queueId),
}));

// --- Workers -----------------------------------------------------------------
// Heartbeat history lives in worker_heartbeats below, not a column here --
// this table is just worker identity/current status.

export const workers = pgTable("workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostname: varchar("hostname", { length: 255 }).notNull(),
  pid: integer("pid"),
  status: workerStatusEnum("status").default("idle").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  statusIdx: index("workers_status_idx").on(table.status),
}));

// --- Worker Heartbeats ---------------------------------------------------------
// Insert-only history: every heartbeat tick is its own row rather than
// overwriting a single column, so "how healthy has this worker been" is a
// real queryable log, not just the latest snapshot. The zombie-cleanup sweep
// and GET /workers both need "the most recent heartbeat per worker," which is
// what the composite (worker_id, heartbeat_at) index below is for.
// Unbounded growth is a known trade-off at 1 row per worker per
// HEARTBEAT_INTERVAL_MS -- a retention/cleanup job is the natural next step,
// not built here (see DEVELOPMENT.md).

export const workerHeartbeats = pgTable("worker_heartbeats", {
  id: uuid("id").primaryKey().defaultRandom(),
  workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  status: workerStatusEnum("status").notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  workerIdx: index("worker_heartbeats_worker_id_idx").on(table.workerId),
  workerHeartbeatAtIdx: index("worker_heartbeats_worker_id_heartbeat_at_idx").on(table.workerId, table.heartbeatAt),
}));

// --- Jobs --------------------------------------------------------------------

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  queueId: uuid("queue_id").notNull().references(() => queues.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 255 }).notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: jobStatusEnum("status").default("queued").notNull(),
  priority: integer("priority").default(0).notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
  // Set only for an occurrence spawned by a recurring rule; the rule itself
  // (including its cron expression) lives in scheduled_jobs, not here.
  scheduledJobId: uuid("scheduled_job_id").references(() => scheduledJobs.id, { onDelete: "set null" }),
  batchId: uuid("batch_id"),
  // Workflow dependency: this job is not claimable until parent_job_id's
  // status is strictly 'completed' (enforced in claim.ts, not by triggers --
  // see DEVELOPMENT.md for why a self-referencing FK is enough on its own).
  // set null on parent delete: a dependency on a row that no longer exists
  // should stop blocking the child rather than orphan it unclaimable forever.
  parentJobId: uuid("parent_job_id").references((): AnyPgColumn => jobs.id, { onDelete: "set null" }),
  // Virtual shard this job hashes into, within its queue's shardCount space.
  // Computed at insert time in application code (see routes/jobs.ts) as
  // hash(id) % SHARD_KEY_SPACE -- a large fixed modulus independent of any
  // one queue's shardCount, so a queue's shardCount can change later without
  // needing every existing job's shardKey recomputed.
  shardKey: integer("shard_key").default(0).notNull(),
  // Optional client-supplied dedupe key, scoped per-queue. Postgres treats
  // every NULL as distinct in a unique index, so jobs that don't opt in never
  // collide with each other -- only two inserts on the same queue reusing the
  // same key do.
  idempotencyKey: varchar("idempotency_key", { length: 255 }),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  claimedBy: uuid("claimed_by").references(() => workers.id, { onDelete: "set null" }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // Perf-critical: worker poll loop filters by status and orders by run_at.
  statusIdx: index("jobs_status_idx").on(table.status),
  runAtIdx: index("jobs_run_at_idx").on(table.runAt),
  queuePollIdx: index("jobs_queue_id_status_run_at_idx").on(table.queueId, table.status, table.runAt),
  batchIdx: index("jobs_batch_id_idx").on(table.batchId),
  scheduledJobIdx: index("jobs_scheduled_job_id_idx").on(table.scheduledJobId),
  idempotencyIdx: uniqueIndex("jobs_queue_id_idempotency_key_idx").on(table.queueId, table.idempotencyKey),
  parentJobIdx: index("jobs_parent_job_id_idx").on(table.parentJobId),
  shardKeyIdx: index("jobs_queue_id_shard_key_idx").on(table.queueId, table.shardKey),
}));

// --- Job Executions ------------------------------------------------------------

export const jobExecutions = pgTable("job_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
  attemptNumber: integer("attempt_number").notNull(),
  status: executionStatusEnum("status").default("running").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  jobIdx: index("job_executions_job_id_idx").on(table.jobId),
  workerIdx: index("job_executions_worker_id_idx").on(table.workerId),
}));

// --- Job Logs ------------------------------------------------------------------

export const jobLogs = pgTable("job_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  executionId: uuid("execution_id").references(() => jobExecutions.id, { onDelete: "cascade" }),
  level: logLevelEnum("level").default("info").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  jobIdx: index("job_logs_job_id_idx").on(table.jobId),
  executionIdx: index("job_logs_execution_id_idx").on(table.executionId),
}));

// --- Dead Letter Queue -----------------------------------------------------------

export const deadLetterQueue = pgTable("dead_letter_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  // One row per job: a job only ever dead-letters once, so this stays 1:1.
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  queueId: uuid("queue_id").notNull().references(() => queues.id, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull(),
  failReason: text("fail_reason").notNull(),
  // Human-readable failure explanation + mitigation, generated by
  // worker-service/src/failureSummary.ts once the job actually dead-letters
  // (not on every retry -- only the terminal failure gets one). Nullable:
  // populated best-effort, a summary-generation error must never block the
  // dead-letter insert itself.
  aiSummary: text("ai_summary"),
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  jobIdx: uniqueIndex("dead_letter_queue_job_id_idx").on(table.jobId),
  queueIdx: index("dead_letter_queue_queue_id_idx").on(table.queueId),
}));

// --- Relations -----------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  projects: many(projects),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, { fields: [organizationMembers.organizationId], references: [organizations.id] }),
  user: one(users, { fields: [organizationMembers.userId], references: [users.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
  organizationMemberships: many(organizationMembers),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, { fields: [projects.organizationId], references: [organizations.id] }),
  owner: one(users, { fields: [projects.ownerId], references: [users.id] }),
  queues: many(queues),
}));

export const queuesRelations = relations(queues, ({ one, many }) => ({
  project: one(projects, { fields: [queues.projectId], references: [projects.id] }),
  retryPolicy: one(retryPolicies, { fields: [queues.id], references: [retryPolicies.queueId] }),
  jobs: many(jobs),
  scheduledJobs: many(scheduledJobs),
  deadLetterEntries: many(deadLetterQueue),
}));

export const retryPoliciesRelations = relations(retryPolicies, ({ one }) => ({
  queue: one(queues, { fields: [retryPolicies.queueId], references: [queues.id] }),
}));

export const scheduledJobsRelations = relations(scheduledJobs, ({ one, many }) => ({
  queue: one(queues, { fields: [scheduledJobs.queueId], references: [queues.id] }),
  occurrences: many(jobs),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  queue: one(queues, { fields: [jobs.queueId], references: [queues.id] }),
  scheduledJob: one(scheduledJobs, { fields: [jobs.scheduledJobId], references: [scheduledJobs.id] }),
  claimedByWorker: one(workers, { fields: [jobs.claimedBy], references: [workers.id] }),
  parentJob: one(jobs, { fields: [jobs.parentJobId], references: [jobs.id], relationName: "jobDependency" }),
  dependentJobs: many(jobs, { relationName: "jobDependency" }),
  executions: many(jobExecutions),
  logs: many(jobLogs),
  deadLetterEntry: one(deadLetterQueue, { fields: [jobs.id], references: [deadLetterQueue.jobId] }),
}));

export const workersRelations = relations(workers, ({ many }) => ({
  claimedJobs: many(jobs),
  executions: many(jobExecutions),
  heartbeats: many(workerHeartbeats),
}));

export const workerHeartbeatsRelations = relations(workerHeartbeats, ({ one }) => ({
  worker: one(workers, { fields: [workerHeartbeats.workerId], references: [workers.id] }),
}));

export const jobExecutionsRelations = relations(jobExecutions, ({ one, many }) => ({
  job: one(jobs, { fields: [jobExecutions.jobId], references: [jobs.id] }),
  worker: one(workers, { fields: [jobExecutions.workerId], references: [workers.id] }),
  logs: many(jobLogs),
}));

export const jobLogsRelations = relations(jobLogs, ({ one }) => ({
  job: one(jobs, { fields: [jobLogs.jobId], references: [jobs.id] }),
  execution: one(jobExecutions, { fields: [jobLogs.executionId], references: [jobExecutions.id] }),
}));

export const deadLetterQueueRelations = relations(deadLetterQueue, ({ one }) => ({
  job: one(jobs, { fields: [deadLetterQueue.jobId], references: [jobs.id] }),
  queue: one(queues, { fields: [deadLetterQueue.queueId], references: [queues.id] }),
}));
