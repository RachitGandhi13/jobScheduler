CREATE TYPE "public"."execution_status" AS ENUM('running', 'success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'scheduled', 'claimed', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."organization_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."retry_strategy" AS ENUM('fixed', 'linear', 'exponential');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('idle', 'busy', 'offline');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dead_letter_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer NOT NULL,
	"fail_reason" text NOT NULL,
	"dead_lettered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"worker_id" uuid,
	"attempt_number" integer NOT NULL,
	"status" "execution_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"execution_id" uuid,
	"level" "log_level" DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_id" uuid NOT NULL,
	"type" varchar(255) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cron_expression" varchar(100),
	"batch_id" uuid,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "organization_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"owner_id" uuid NOT NULL,
	"api_key" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"concurrency_limit" integer DEFAULT 1 NOT NULL,
	"retry_strategy" "retry_strategy" DEFAULT 'fixed' NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"retry_base_delay_ms" integer DEFAULT 1000 NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"name" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hostname" varchar(255) NOT NULL,
	"pid" integer,
	"status" "worker_status" DEFAULT 'idle' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dead_letter_queue" ADD CONSTRAINT "dead_letter_queue_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dead_letter_queue" ADD CONSTRAINT "dead_letter_queue_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_execution_id_job_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."job_executions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_claimed_by_workers_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queues" ADD CONSTRAINT "queues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dead_letter_queue_job_id_idx" ON "dead_letter_queue" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dead_letter_queue_queue_id_idx" ON "dead_letter_queue" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_executions_job_id_idx" ON "job_executions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_executions_worker_id_idx" ON "job_executions" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_logs_job_id_idx" ON "job_logs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_logs_execution_id_idx" ON "job_logs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_run_at_idx" ON "jobs" USING btree ("run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_queue_id_status_run_at_idx" ON "jobs" USING btree ("queue_id","status","run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_batch_id_idx" ON "jobs" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_members_org_id_user_id_idx" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_members_user_id_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_organization_id_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_owner_id_idx" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_api_key_idx" ON "projects" USING btree ("api_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queues_project_id_idx" ON "queues" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "queues_project_id_name_idx" ON "queues" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_status_idx" ON "workers" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_last_heartbeat_at_idx" ON "workers" USING btree ("last_heartbeat_at");