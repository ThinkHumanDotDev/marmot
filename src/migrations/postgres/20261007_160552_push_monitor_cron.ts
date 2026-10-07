import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_push_schedule" AS ENUM('interval', 'cron');
  CREATE TYPE "public"."enum_monitors_status_last_push_status" AS ENUM('up', 'down');
  CREATE TYPE "public"."enum_push_events_kind" AS ENUM('success', 'fail', 'start', 'log');
  CREATE TYPE "public"."enum_push_events_source" AS ENUM('http', 'email');
  CREATE TABLE "push_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"organization_id" integer,
  	"kind" "enum_push_events_kind" NOT NULL,
  	"source" "enum_push_events_source" DEFAULT 'http',
  	"msg" varchar,
  	"body" varchar,
  	"body_truncated" boolean DEFAULT false,
  	"rid" varchar,
  	"exit_code" numeric,
  	"duration" numeric,
  	"method" varchar,
  	"time" timestamp(3) with time zone NOT NULL
  );
  
  ALTER TABLE "monitors" ADD COLUMN "push_schedule" "enum_monitors_push_schedule" DEFAULT 'interval';
  ALTER TABLE "monitors" ADD COLUMN "push_cron" varchar;
  ALTER TABLE "monitors" ADD COLUMN "push_timezone" varchar DEFAULT 'SAME_AS_SERVER';
  ALTER TABLE "monitors" ADD COLUMN "push_grace" numeric;
  ALTER TABLE "monitors" ADD COLUMN "push_max_duration" numeric;
  ALTER TABLE "monitors" ADD COLUMN "status_last_push_status" "enum_monitors_status_last_push_status";
  ALTER TABLE "monitors" ADD COLUMN "status_push_runs" jsonb;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "push_events_id" integer;
  ALTER TABLE "push_events" ADD CONSTRAINT "push_events_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "push_events" ADD CONSTRAINT "push_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "push_events_monitor_idx" ON "push_events" USING btree ("monitor_id");
  CREATE INDEX "push_events_organization_idx" ON "push_events" USING btree ("organization_id");
  CREATE INDEX "push_events_time_idx" ON "push_events" USING btree ("time");
  CREATE INDEX "monitor_time_1_idx" ON "push_events" USING btree ("monitor_id","time");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_push_events_fk" FOREIGN KEY ("push_events_id") REFERENCES "public"."push_events"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_push_events_id_idx" ON "payload_locked_documents_rels" USING btree ("push_events_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "push_events" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "push_events" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_push_events_fk";
  
  DROP INDEX "payload_locked_documents_rels_push_events_id_idx";
  ALTER TABLE "monitors" DROP COLUMN "push_schedule";
  ALTER TABLE "monitors" DROP COLUMN "push_cron";
  ALTER TABLE "monitors" DROP COLUMN "push_timezone";
  ALTER TABLE "monitors" DROP COLUMN "push_grace";
  ALTER TABLE "monitors" DROP COLUMN "push_max_duration";
  ALTER TABLE "monitors" DROP COLUMN "status_last_push_status";
  ALTER TABLE "monitors" DROP COLUMN "status_push_runs";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "push_events_id";
  DROP TYPE "public"."enum_monitors_push_schedule";
  DROP TYPE "public"."enum_monitors_status_last_push_status";
  DROP TYPE "public"."enum_push_events_kind";
  DROP TYPE "public"."enum_push_events_source";`)
}
