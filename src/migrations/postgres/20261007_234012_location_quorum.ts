import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_quorum" AS ENUM('any', 'half', 'all');
  CREATE TYPE "public"."enum_heartbeats_location_status" AS ENUM('up', 'down', 'pending', 'maintenance', 'degraded');
  CREATE TYPE "public"."enum_monitor_location_states_last_status" AS ENUM('up', 'down', 'pending', 'maintenance', 'degraded');
  CREATE TYPE "public"."enum_monitor_location_states_settled_status" AS ENUM('up', 'down', 'pending', 'maintenance', 'degraded');
  ALTER TYPE "public"."enum_heartbeats_trigger" ADD VALUE 'quorum';
  CREATE TABLE "monitor_location_states" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"location_key" varchar NOT NULL,
  	"last_status" "enum_monitor_location_states_last_status",
  	"settled_status" "enum_monitor_location_states_settled_status",
  	"retries" numeric DEFAULT 0,
  	"down_count" numeric DEFAULT 0,
  	"recoveries" numeric DEFAULT 0,
  	"last_check_at" timestamp(3) with time zone,
  	"last_ping" numeric,
  	"last_msg" varchar
  );
  
  CREATE TABLE "stat_location_hourly" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"location" varchar NOT NULL,
  	"timestamp" numeric NOT NULL,
  	"up" numeric DEFAULT 0 NOT NULL,
  	"down" numeric DEFAULT 0 NOT NULL,
  	"ping" numeric,
  	"ping_min" numeric,
  	"ping_max" numeric,
  	"extras" jsonb
  );
  
  ALTER TABLE "monitors" ADD COLUMN "include_local" boolean DEFAULT false;
  ALTER TABLE "monitors" ADD COLUMN "quorum" "enum_monitors_quorum" DEFAULT 'half';
  ALTER TABLE "heartbeats" ADD COLUMN "location_status" "enum_heartbeats_location_status";
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "monitor_location_states_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "stat_location_hourly_id" integer;
  ALTER TABLE "monitor_location_states" ADD CONSTRAINT "monitor_location_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitor_location_states" ADD CONSTRAINT "monitor_location_states_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "stat_location_hourly" ADD CONSTRAINT "stat_location_hourly_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "stat_location_hourly" ADD CONSTRAINT "stat_location_hourly_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "monitor_location_states_organization_idx" ON "monitor_location_states" USING btree ("organization_id");
  CREATE INDEX "monitor_location_states_monitor_idx" ON "monitor_location_states" USING btree ("monitor_id");
  CREATE INDEX "monitor_location_states_location_key_idx" ON "monitor_location_states" USING btree ("location_key");
  CREATE UNIQUE INDEX "monitor_locationKey_idx" ON "monitor_location_states" USING btree ("monitor_id","location_key");
  CREATE INDEX "stat_location_hourly_monitor_idx" ON "stat_location_hourly" USING btree ("monitor_id");
  CREATE INDEX "stat_location_hourly_organization_idx" ON "stat_location_hourly" USING btree ("organization_id");
  CREATE INDEX "stat_location_hourly_timestamp_idx" ON "stat_location_hourly" USING btree ("timestamp");
  CREATE UNIQUE INDEX "monitor_location_timestamp_idx" ON "stat_location_hourly" USING btree ("monitor_id","location","timestamp");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_monitor_location_states_fk" FOREIGN KEY ("monitor_location_states_id") REFERENCES "public"."monitor_location_states"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_stat_location_hourly_fk" FOREIGN KEY ("stat_location_hourly_id") REFERENCES "public"."stat_location_hourly"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_monitor_location_states_id_idx" ON "payload_locked_documents_rels" USING btree ("monitor_location_states_id");
  CREATE INDEX "payload_locked_documents_rels_stat_location_hourly_id_idx" ON "payload_locked_documents_rels" USING btree ("stat_location_hourly_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitor_location_states" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "stat_location_hourly" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "monitor_location_states" CASCADE;
  DROP TABLE "stat_location_hourly" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_monitor_location_states_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_stat_location_hourly_fk";
  
  ALTER TABLE "heartbeats" ALTER COLUMN "trigger" SET DATA TYPE text;
  DROP TYPE "public"."enum_heartbeats_trigger";
  CREATE TYPE "public"."enum_heartbeats_trigger" AS ENUM('manual');
  ALTER TABLE "heartbeats" ALTER COLUMN "trigger" SET DATA TYPE "public"."enum_heartbeats_trigger" USING "trigger"::"public"."enum_heartbeats_trigger";
  DROP INDEX "payload_locked_documents_rels_monitor_location_states_id_idx";
  DROP INDEX "payload_locked_documents_rels_stat_location_hourly_id_idx";
  ALTER TABLE "monitors" DROP COLUMN "include_local";
  ALTER TABLE "monitors" DROP COLUMN "quorum";
  ALTER TABLE "heartbeats" DROP COLUMN "location_status";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "monitor_location_states_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "stat_location_hourly_id";
  DROP TYPE "public"."enum_monitors_quorum";
  DROP TYPE "public"."enum_heartbeats_location_status";
  DROP TYPE "public"."enum_monitor_location_states_last_status";
  DROP TYPE "public"."enum_monitor_location_states_settled_status";`)
}
