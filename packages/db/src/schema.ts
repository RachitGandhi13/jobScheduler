import { relations } from "drizzle-orm";
import {
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

export const queues = pgTable("queues", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  priority: integer("priority").default(0).notNull(),
  concurrencyLimit: integer("concurrency_limit").default(1).notNull(),
  retryStrategy: retryStrategyEnum("retry_strategy").default("fixed").notNull(),
  maxRetries: integer("max_retries").default(3).notNull(),
  retryBaseDelayMs: integer("retry_base_delay_ms").default(1000).notNull(),
  isPaused: boolean("is_paused").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  projectIdx: index("queues_project_id_idx").on(table.projectId),
  projectNameIdx: uniqueIndex("queues_project_id_name_idx").on(table.projectId, table.name),
}));

// --- Workers -----------------------------------------------------------------

export const workers = pgTable("workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostname: varchar("hostname", { length: 255 }).notNull(),
  pid: integer("pid"),
  status: workerStatusEnum("status").default("idle").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  statusIdx: index("workers_status_idx").on(table.status),
  lastHeartbeatIdx: index("workers_last_heartbeat_at_idx").on(table.lastHeartbeatAt),
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
  cronExpression: varchar("cron_expression", { length: 100 }),
  batchId: uuid("batch_id"),
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
  jobs: many(jobs),
  deadLetterEntries: many(deadLetterQueue),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  queue: one(queues, { fields: [jobs.queueId], references: [queues.id] }),
  claimedByWorker: one(workers, { fields: [jobs.claimedBy], references: [workers.id] }),
  executions: many(jobExecutions),
  logs: many(jobLogs),
  deadLetterEntry: one(deadLetterQueue, { fields: [jobs.id], references: [deadLetterQueue.jobId] }),
}));

export const workersRelations = relations(workers, ({ many }) => ({
  claimedJobs: many(jobs),
  executions: many(jobExecutions),
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
