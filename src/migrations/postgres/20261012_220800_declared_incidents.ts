import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_declared_incidents_timeline_type" AS ENUM('declared', 'severity_changed', 'status_changed', 'commander_changed', 'note', 'linked', 'unlinked', 'postmortem_drafted', 'postmortem_approved', 'closed');
  CREATE TYPE "public"."enum_declared_incidents_severity" AS ENUM('critical', 'major', 'minor');
  CREATE TYPE "public"."enum_declared_incidents_status" AS ENUM('open', 'mitigated', 'resolved', 'closed', 'canceled');
  CREATE TYPE "public"."enum_declared_incidents_postmortem_status" AS ENUM('none', 'draft', 'approved');
  ALTER TYPE "public"."enum_notifications_events" ADD VALUE 'incident';
  CREATE TABLE "declared_incidents_timeline" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"type" "enum_declared_incidents_timeline_type" NOT NULL,
  	"at" timestamp(3) with time zone NOT NULL,
  	"by_id" integer,
  	"from" varchar,
  	"to" varchar,
  	"message" varchar
  );
  
  CREATE TABLE "declared_incidents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"title" varchar NOT NULL,
  	"severity" "enum_declared_incidents_severity" DEFAULT 'major' NOT NULL,
  	"status" "enum_declared_incidents_status" DEFAULT 'open' NOT NULL,
  	"summary" varchar,
  	"commander_id" integer,
  	"declared_by_id" integer,
  	"started_at" timestamp(3) with time zone NOT NULL,
  	"mitigated_at" timestamp(3) with time zone,
  	"resolved_at" timestamp(3) with time zone,
  	"closed_at" timestamp(3) with time zone,
  	"canceled_at" timestamp(3) with time zone,
  	"monitor_incident_id" integer,
  	"status_page_incident_id" integer,
  	"postmortem_status" "enum_declared_incidents_postmortem_status" DEFAULT 'none',
  	"postmortem_content" varchar,
  	"postmortem_approved_by_id" integer,
  	"postmortem_approved_at" timestamp(3) with time zone,
  	"postmortem_skipped" boolean DEFAULT false,
  	"last_activity_at" timestamp(3) with time zone,
  	"next_reminder_at" timestamp(3) with time zone,
  	"reminders_sent" numeric DEFAULT 0,
  	"last_reminder_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "declared_incidents_id" integer;
  ALTER TABLE "declared_incidents_timeline" ADD CONSTRAINT "declared_incidents_timeline_by_id_users_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "declared_incidents_timeline" ADD CONSTRAINT "declared_incidents_timeline_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."declared_incidents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "declared_incidents" ADD CONSTRAINT "declared_incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "declared_incidents" ADD CONSTRAINT "declared_incidents_commander_id_users_id_fk" FOREIGN KEY ("commander_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "declared_incidents" ADD CONSTRAINT "declared_incidents_declared_by_id_users_id_fk" FOREIGN KEY ("declared_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "declared_incidents" ADD CONSTRAINT "declared_incidents_monitor_incident_id_monitor_incidents_id_fk" FOREIGN KEY ("monitor_incident_id") REFERENCES "public"."monitor_incidents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "declared_incidents" ADD CONSTRAINT "declared_incidents_status_page_incident_id_incidents_id_fk" FOREIGN KEY ("status_page_incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "declared_incidents" ADD CONSTRAINT "declared_incidents_postmortem_approved_by_id_users_id_fk" FOREIGN KEY ("postmortem_approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "declared_incidents_timeline_order_idx" ON "declared_incidents_timeline" USING btree ("_order");
  CREATE INDEX "declared_incidents_timeline_parent_id_idx" ON "declared_incidents_timeline" USING btree ("_parent_id");
  CREATE INDEX "declared_incidents_timeline_by_idx" ON "declared_incidents_timeline" USING btree ("by_id");
  CREATE INDEX "declared_incidents_organization_idx" ON "declared_incidents" USING btree ("organization_id");
  CREATE INDEX "declared_incidents_status_idx" ON "declared_incidents" USING btree ("status");
  CREATE INDEX "declared_incidents_commander_idx" ON "declared_incidents" USING btree ("commander_id");
  CREATE INDEX "declared_incidents_declared_by_idx" ON "declared_incidents" USING btree ("declared_by_id");
  CREATE INDEX "declared_incidents_started_at_idx" ON "declared_incidents" USING btree ("started_at");
  CREATE INDEX "declared_incidents_monitor_incident_idx" ON "declared_incidents" USING btree ("monitor_incident_id");
  CREATE INDEX "declared_incidents_status_page_incident_idx" ON "declared_incidents" USING btree ("status_page_incident_id");
  CREATE INDEX "declared_incidents_postmortem_postmortem_approved_by_idx" ON "declared_incidents" USING btree ("postmortem_approved_by_id");
  CREATE INDEX "declared_incidents_next_reminder_at_idx" ON "declared_incidents" USING btree ("next_reminder_at");
  CREATE INDEX "declared_incidents_updated_at_idx" ON "declared_incidents" USING btree ("updated_at");
  CREATE INDEX "declared_incidents_created_at_idx" ON "declared_incidents" USING btree ("created_at");
  CREATE INDEX "organization_startedAt_1_idx" ON "declared_incidents" USING btree ("organization_id","started_at");
  CREATE INDEX "status_nextReminderAt_idx" ON "declared_incidents" USING btree ("status","next_reminder_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_declared_incidents_fk" FOREIGN KEY ("declared_incidents_id") REFERENCES "public"."declared_incidents"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_declared_incidents_id_idx" ON "payload_locked_documents_rels" USING btree ("declared_incidents_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "declared_incidents_timeline" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "declared_incidents" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "declared_incidents_timeline" CASCADE;
  DROP TABLE "declared_incidents" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_declared_incidents_fk";
  
  ALTER TABLE "notifications_events" ALTER COLUMN "value" SET DATA TYPE text;
  DROP TYPE "public"."enum_notifications_events";
  CREATE TYPE "public"."enum_notifications_events" AS ENUM('down', 'up', 'degraded', 'reminder', 'certificate', 'maintenance', 'acknowledged', 'resolved');
  ALTER TABLE "notifications_events" ALTER COLUMN "value" SET DATA TYPE "public"."enum_notifications_events" USING "value"::"public"."enum_notifications_events";
  DROP INDEX "payload_locked_documents_rels_declared_incidents_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "declared_incidents_id";
  DROP TYPE "public"."enum_declared_incidents_timeline_type";
  DROP TYPE "public"."enum_declared_incidents_severity";
  DROP TYPE "public"."enum_declared_incidents_status";
  DROP TYPE "public"."enum_declared_incidents_postmortem_status";`)
}
