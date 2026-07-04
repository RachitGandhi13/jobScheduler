CREATE TABLE IF NOT EXISTS "retry_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_id" uuid NOT NULL,
	"strategy" "retry_strategy" DEFAULT 'fixed' NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"base_delay_ms" integer DEFAULT 1000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_id" uuid NOT NULL,
	"type" varchar(255) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"cron_expression" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"status" "worker_status" NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "workers_last_heartbeat_at_idx";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "scheduled_job_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retry_policies" ADD CONSTRAINT "retry_policies_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worker_heartbeats" ADD CONSTRAINT "worker_heartbeats_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retry_policies_queue_id_idx" ON "retry_policies" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_jobs_queue_id_idx" ON "scheduled_jobs" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_heartbeats_worker_id_idx" ON "worker_heartbeats" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_heartbeats_worker_id_heartbeat_at_idx" ON "worker_heartbeats" USING btree ("worker_id","heartbeat_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_scheduled_job_id_scheduled_jobs_id_fk" FOREIGN KEY ("scheduled_job_id") REFERENCES "public"."scheduled_jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_scheduled_job_id_idx" ON "jobs" USING btree ("scheduled_job_id");--> statement-breakpoint
-- Backfill: one scheduled_jobs row per distinct recurring series (a series is
-- every job sharing the same queue/type/cron_expression -- the chaining logic
-- in worker-service copied cron_expression onto every occurrence, so a naive
-- 1-row-per-job backfill would wrongly create a duplicate rule per occurrence).
INSERT INTO "scheduled_jobs" ("queue_id", "type", "payload", "priority", "max_attempts", "cron_expression")
SELECT DISTINCT ON ("queue_id", "type", "cron_expression") "queue_id", "type", "payload", "priority", "max_attempts", "cron_expression"
FROM "jobs"
WHERE "cron_expression" IS NOT NULL;--> statement-breakpoint
-- Point every existing occurrence at the scheduled_jobs row for its series.
UPDATE "jobs" AS j
SET "scheduled_job_id" = sj."id"
FROM "scheduled_jobs" AS sj
WHERE j."cron_expression" IS NOT NULL
	AND j."queue_id" = sj."queue_id"
	AND j."type" = sj."type"
	AND j."cron_expression" = sj."cron_expression";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "cron_expression";--> statement-breakpoint
-- Backfill: preserve every existing queue's retry config as its retry_policies row.
INSERT INTO "retry_policies" ("queue_id", "strategy", "max_retries", "base_delay_ms")
SELECT "id", "retry_strategy", "max_retries", "retry_base_delay_ms" FROM "queues";--> statement-breakpoint
ALTER TABLE "queues" DROP COLUMN IF EXISTS "retry_strategy";--> statement-breakpoint
ALTER TABLE "queues" DROP COLUMN IF EXISTS "max_retries";--> statement-breakpoint
ALTER TABLE "queues" DROP COLUMN IF EXISTS "retry_base_delay_ms";--> statement-breakpoint
-- Backfill: preserve each worker's last known heartbeat as its first history row.
INSERT INTO "worker_heartbeats" ("worker_id", "status", "heartbeat_at")
SELECT "id", "status", "last_heartbeat_at" FROM "workers" WHERE "last_heartbeat_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" DROP COLUMN IF EXISTS "last_heartbeat_at";