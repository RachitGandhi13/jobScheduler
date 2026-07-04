ALTER TABLE "dead_letter_queue" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "parent_job_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "shard_key" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "rate_limit_per_minute" integer;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "shard_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "rate_limit_per_minute" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_job_id_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_parent_job_id_idx" ON "jobs" USING btree ("parent_job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_queue_id_shard_key_idx" ON "jobs" USING btree ("queue_id","shard_key");