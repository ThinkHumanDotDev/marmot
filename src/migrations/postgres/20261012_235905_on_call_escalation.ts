import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitor_incidents_escalation_status" AS ENUM('active', 'stopped', 'exhausted');
  CREATE TYPE "public"."enum_on_call_schedules_layers_restrictions_days" AS ENUM('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun');
  CREATE TYPE "public"."enum_on_call_schedules_layers_rotation" AS ENUM('daily', 'weekly', 'custom');
  CREATE TYPE "public"."enum_on_call_schedules_layers_custom_unit" AS ENUM('hours', 'days');
  CREATE TYPE "public"."enum_escalation_policies_steps_targets_type" AS ENUM('schedule', 'user', 'channel');
  ALTER TYPE "public"."enum_monitor_incidents_timeline_type" ADD VALUE 'escalated';
  CREATE TABLE "on_call_schedules_layers_restrictions_days" (
  	"order" integer NOT NULL,
  	"parent_id" varchar NOT NULL,
  	"value" "enum_on_call_schedules_layers_restrictions_days",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "on_call_schedules_layers_restrictions" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"start" varchar NOT NULL,
  	"end" varchar NOT NULL
  );
  
  CREATE TABLE "on_call_schedules_layers" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"timezone" varchar,
  	"rotation" "enum_on_call_schedules_layers_rotation" DEFAULT 'weekly' NOT NULL,
  	"custom_length" numeric,
  	"custom_unit" "enum_on_call_schedules_layers_custom_unit" DEFAULT 'days',
  	"handoff_time" varchar DEFAULT '09:00' NOT NULL,
  	"start_date" varchar NOT NULL
  );
  
  CREATE TABLE "on_call_schedules_overrides" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"user_id" integer NOT NULL,
  	"start" timestamp(3) with time zone NOT NULL,
  	"end" timestamp(3) with time zone NOT NULL,
  	"note" varchar
  );
  
  CREATE TABLE "on_call_schedules" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"description" varchar,
  	"timezone" varchar DEFAULT 'UTC' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "on_call_schedules_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "escalation_policies_steps_targets" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"type" "enum_escalation_policies_steps_targets_type" NOT NULL,
  	"schedule_id" integer,
  	"user_id" integer,
  	"channel_id" integer
  );
  
  CREATE TABLE "escalation_policies_steps" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"escalate_after_minutes" numeric DEFAULT 10 NOT NULL
  );
  
  CREATE TABLE "escalation_policies" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"description" varchar,
  	"repeat" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "monitors" ADD COLUMN "escalation_policy_id" integer;
  ALTER TABLE "monitor_incidents" ADD COLUMN "escalation_policy_id" integer;
  ALTER TABLE "monitor_incidents" ADD COLUMN "escalation_status" "enum_monitor_incidents_escalation_status";
  ALTER TABLE "monitor_incidents" ADD COLUMN "escalation_step" numeric;
  ALTER TABLE "monitor_incidents" ADD COLUMN "escalation_round" numeric;
  ALTER TABLE "monitor_incidents" ADD COLUMN "escalation_next_at" timestamp(3) with time zone;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "on_call_schedules_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "escalation_policies_id" integer;
  ALTER TABLE "on_call_schedules_layers_restrictions_days" ADD CONSTRAINT "on_call_schedules_layers_restrictions_days_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."on_call_schedules_layers_restrictions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "on_call_schedules_layers_restrictions" ADD CONSTRAINT "on_call_schedules_layers_restrictions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."on_call_schedules_layers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "on_call_schedules_layers" ADD CONSTRAINT "on_call_schedules_layers_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."on_call_schedules"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "on_call_schedules_overrides" ADD CONSTRAINT "on_call_schedules_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "on_call_schedules_overrides" ADD CONSTRAINT "on_call_schedules_overrides_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."on_call_schedules"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "on_call_schedules" ADD CONSTRAINT "on_call_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "on_call_schedules_rels" ADD CONSTRAINT "on_call_schedules_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."on_call_schedules"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "on_call_schedules_rels" ADD CONSTRAINT "on_call_schedules_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "escalation_policies_steps_targets" ADD CONSTRAINT "escalation_policies_steps_targets_schedule_id_on_call_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."on_call_schedules"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "escalation_policies_steps_targets" ADD CONSTRAINT "escalation_policies_steps_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "escalation_policies_steps_targets" ADD CONSTRAINT "escalation_policies_steps_targets_channel_id_notifications_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "escalation_policies_steps_targets" ADD CONSTRAINT "escalation_policies_steps_targets_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."escalation_policies_steps"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "escalation_policies_steps" ADD CONSTRAINT "escalation_policies_steps_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."escalation_policies"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "escalation_policies" ADD CONSTRAINT "escalation_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "on_call_schedules_layers_restrictions_days_order_idx" ON "on_call_schedules_layers_restrictions_days" USING btree ("order");
  CREATE INDEX "on_call_schedules_layers_restrictions_days_parent_idx" ON "on_call_schedules_layers_restrictions_days" USING btree ("parent_id");
  CREATE INDEX "on_call_schedules_layers_restrictions_order_idx" ON "on_call_schedules_layers_restrictions" USING btree ("_order");
  CREATE INDEX "on_call_schedules_layers_restrictions_parent_id_idx" ON "on_call_schedules_layers_restrictions" USING btree ("_parent_id");
  CREATE INDEX "on_call_schedules_layers_order_idx" ON "on_call_schedules_layers" USING btree ("_order");
  CREATE INDEX "on_call_schedules_layers_parent_id_idx" ON "on_call_schedules_layers" USING btree ("_parent_id");
  CREATE INDEX "on_call_schedules_overrides_order_idx" ON "on_call_schedules_overrides" USING btree ("_order");
  CREATE INDEX "on_call_schedules_overrides_parent_id_idx" ON "on_call_schedules_overrides" USING btree ("_parent_id");
  CREATE INDEX "on_call_schedules_overrides_user_idx" ON "on_call_schedules_overrides" USING btree ("user_id");
  CREATE INDEX "on_call_schedules_organization_idx" ON "on_call_schedules" USING btree ("organization_id");
  CREATE INDEX "on_call_schedules_updated_at_idx" ON "on_call_schedules" USING btree ("updated_at");
  CREATE INDEX "on_call_schedules_created_at_idx" ON "on_call_schedules" USING btree ("created_at");
  CREATE INDEX "on_call_schedules_rels_order_idx" ON "on_call_schedules_rels" USING btree ("order");
  CREATE INDEX "on_call_schedules_rels_parent_idx" ON "on_call_schedules_rels" USING btree ("parent_id");
  CREATE INDEX "on_call_schedules_rels_path_idx" ON "on_call_schedules_rels" USING btree ("path");
  CREATE INDEX "on_call_schedules_rels_users_id_idx" ON "on_call_schedules_rels" USING btree ("users_id");
  CREATE INDEX "escalation_policies_steps_targets_order_idx" ON "escalation_policies_steps_targets" USING btree ("_order");
  CREATE INDEX "escalation_policies_steps_targets_parent_id_idx" ON "escalation_policies_steps_targets" USING btree ("_parent_id");
  CREATE INDEX "escalation_policies_steps_targets_schedule_idx" ON "escalation_policies_steps_targets" USING btree ("schedule_id");
  CREATE INDEX "escalation_policies_steps_targets_user_idx" ON "escalation_policies_steps_targets" USING btree ("user_id");
  CREATE INDEX "escalation_policies_steps_targets_channel_idx" ON "escalation_policies_steps_targets" USING btree ("channel_id");
  CREATE INDEX "escalation_policies_steps_order_idx" ON "escalation_policies_steps" USING btree ("_order");
  CREATE INDEX "escalation_policies_steps_parent_id_idx" ON "escalation_policies_steps" USING btree ("_parent_id");
  CREATE INDEX "escalation_policies_organization_idx" ON "escalation_policies" USING btree ("organization_id");
  CREATE INDEX "escalation_policies_updated_at_idx" ON "escalation_policies" USING btree ("updated_at");
  CREATE INDEX "escalation_policies_created_at_idx" ON "escalation_policies" USING btree ("created_at");
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_escalation_policy_id_escalation_policies_id_fk" FOREIGN KEY ("escalation_policy_id") REFERENCES "public"."escalation_policies"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitor_incidents" ADD CONSTRAINT "monitor_incidents_escalation_policy_id_escalation_policies_id_fk" FOREIGN KEY ("escalation_policy_id") REFERENCES "public"."escalation_policies"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_on_call_schedules_fk" FOREIGN KEY ("on_call_schedules_id") REFERENCES "public"."on_call_schedules"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_escalation_policies_fk" FOREIGN KEY ("escalation_policies_id") REFERENCES "public"."escalation_policies"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "monitors_escalation_policy_idx" ON "monitors" USING btree ("escalation_policy_id");
  CREATE INDEX "monitor_incidents_escalation_policy_idx" ON "monitor_incidents" USING btree ("escalation_policy_id");
  CREATE INDEX "payload_locked_documents_rels_on_call_schedules_id_idx" ON "payload_locked_documents_rels" USING btree ("on_call_schedules_id");
  CREATE INDEX "payload_locked_documents_rels_escalation_policies_id_idx" ON "payload_locked_documents_rels" USING btree ("escalation_policies_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "on_call_schedules_layers_restrictions_days" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "on_call_schedules_layers_restrictions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "on_call_schedules_layers" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "on_call_schedules_overrides" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "on_call_schedules" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "on_call_schedules_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "escalation_policies_steps_targets" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "escalation_policies_steps" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "escalation_policies" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "on_call_schedules_layers_restrictions_days" CASCADE;
  DROP TABLE "on_call_schedules_layers_restrictions" CASCADE;
  DROP TABLE "on_call_schedules_layers" CASCADE;
  DROP TABLE "on_call_schedules_overrides" CASCADE;
  DROP TABLE "on_call_schedules" CASCADE;
  DROP TABLE "on_call_schedules_rels" CASCADE;
  DROP TABLE "escalation_policies_steps_targets" CASCADE;
  DROP TABLE "escalation_policies_steps" CASCADE;
  DROP TABLE "escalation_policies" CASCADE;
  ALTER TABLE "monitors" DROP CONSTRAINT "monitors_escalation_policy_id_escalation_policies_id_fk";
  
  ALTER TABLE "monitor_incidents" DROP CONSTRAINT "monitor_incidents_escalation_policy_id_escalation_policies_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_on_call_schedules_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_escalation_policies_fk";
  
  ALTER TABLE "monitor_incidents_timeline" ALTER COLUMN "type" SET DATA TYPE text;
  DROP TYPE "public"."enum_monitor_incidents_timeline_type";
  CREATE TYPE "public"."enum_monitor_incidents_timeline_type" AS ENUM('opened', 'maintenance', 'acknowledged', 'resolved', 'published');
  ALTER TABLE "monitor_incidents_timeline" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitor_incidents_timeline_type" USING "type"::"public"."enum_monitor_incidents_timeline_type";
  DROP INDEX "monitors_escalation_policy_idx";
  DROP INDEX "monitor_incidents_escalation_policy_idx";
  DROP INDEX "payload_locked_documents_rels_on_call_schedules_id_idx";
  DROP INDEX "payload_locked_documents_rels_escalation_policies_id_idx";
  ALTER TABLE "monitors" DROP COLUMN "escalation_policy_id";
  ALTER TABLE "monitor_incidents" DROP COLUMN "escalation_policy_id";
  ALTER TABLE "monitor_incidents" DROP COLUMN "escalation_status";
  ALTER TABLE "monitor_incidents" DROP COLUMN "escalation_step";
  ALTER TABLE "monitor_incidents" DROP COLUMN "escalation_round";
  ALTER TABLE "monitor_incidents" DROP COLUMN "escalation_next_at";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "on_call_schedules_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "escalation_policies_id";
  DROP TYPE "public"."enum_monitor_incidents_escalation_status";
  DROP TYPE "public"."enum_on_call_schedules_layers_restrictions_days";
  DROP TYPE "public"."enum_on_call_schedules_layers_rotation";
  DROP TYPE "public"."enum_on_call_schedules_layers_custom_unit";
  DROP TYPE "public"."enum_escalation_policies_steps_targets_type";`)
}
