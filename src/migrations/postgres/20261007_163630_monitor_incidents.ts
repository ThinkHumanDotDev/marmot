import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitor_incidents_timeline_type" AS ENUM('opened', 'maintenance', 'acknowledged', 'resolved', 'published');
  CREATE TYPE "public"."enum_monitor_incidents_timeline_via" AS ENUM('dashboard', 'api', 'link');
  CREATE TYPE "public"."enum_monitor_incidents_status" AS ENUM('open', 'acknowledged', 'resolved');
  CREATE TYPE "public"."enum_monitor_incidents_acknowledged_via" AS ENUM('dashboard', 'api', 'link');
  ALTER TYPE "public"."enum_notifications_events" ADD VALUE 'acknowledged';
  ALTER TYPE "public"."enum_notifications_events" ADD VALUE 'resolved';
  CREATE TABLE "monitor_incidents_timeline" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"type" "enum_monitor_incidents_timeline_type" NOT NULL,
  	"at" timestamp(3) with time zone NOT NULL,
  	"by_id" integer,
  	"via" "enum_monitor_incidents_timeline_via",
  	"message" varchar
  );
  
  CREATE TABLE "monitor_incidents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"status" "enum_monitor_incidents_status" DEFAULT 'open' NOT NULL,
  	"open_key" varchar,
  	"cause" varchar,
  	"started_at" timestamp(3) with time zone NOT NULL,
  	"acknowledged_at" timestamp(3) with time zone,
  	"resolved_at" timestamp(3) with time zone,
  	"acknowledged_by_id" integer,
  	"acknowledged_via" "enum_monitor_incidents_acknowledged_via",
  	"resolved_by_id" integer,
  	"auto_resolved" boolean DEFAULT false,
  	"reminders_sent" numeric DEFAULT 0,
  	"last_reminder_at" timestamp(3) with time zone,
  	"status_page_incident_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "monitor_incidents_id" integer;
  ALTER TABLE "monitor_incidents_timeline" ADD CONSTRAINT "monitor_incidents_timeline_by_id_users_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitor_incidents_timeline" ADD CONSTRAINT "monitor_incidents_timeline_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."monitor_incidents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "monitor_incidents" ADD CONSTRAINT "monitor_incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitor_incidents" ADD CONSTRAINT "monitor_incidents_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitor_incidents" ADD CONSTRAINT "monitor_incidents_acknowledged_by_id_users_id_fk" FOREIGN KEY ("acknowledged_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitor_incidents" ADD CONSTRAINT "monitor_incidents_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitor_incidents" ADD CONSTRAINT "monitor_incidents_status_page_incident_id_incidents_id_fk" FOREIGN KEY ("status_page_incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "monitor_incidents_timeline_order_idx" ON "monitor_incidents_timeline" USING btree ("_order");
  CREATE INDEX "monitor_incidents_timeline_parent_id_idx" ON "monitor_incidents_timeline" USING btree ("_parent_id");
  CREATE INDEX "monitor_incidents_timeline_by_idx" ON "monitor_incidents_timeline" USING btree ("by_id");
  CREATE INDEX "monitor_incidents_organization_idx" ON "monitor_incidents" USING btree ("organization_id");
  CREATE INDEX "monitor_incidents_monitor_idx" ON "monitor_incidents" USING btree ("monitor_id");
  CREATE INDEX "monitor_incidents_status_idx" ON "monitor_incidents" USING btree ("status");
  CREATE UNIQUE INDEX "monitor_incidents_open_key_idx" ON "monitor_incidents" USING btree ("open_key");
  CREATE INDEX "monitor_incidents_started_at_idx" ON "monitor_incidents" USING btree ("started_at");
  CREATE INDEX "monitor_incidents_acknowledged_by_idx" ON "monitor_incidents" USING btree ("acknowledged_by_id");
  CREATE INDEX "monitor_incidents_resolved_by_idx" ON "monitor_incidents" USING btree ("resolved_by_id");
  CREATE INDEX "monitor_incidents_status_page_incident_idx" ON "monitor_incidents" USING btree ("status_page_incident_id");
  CREATE INDEX "monitor_incidents_updated_at_idx" ON "monitor_incidents" USING btree ("updated_at");
  CREATE INDEX "monitor_incidents_created_at_idx" ON "monitor_incidents" USING btree ("created_at");
  CREATE INDEX "organization_startedAt_idx" ON "monitor_incidents" USING btree ("organization_id","started_at");
  CREATE INDEX "monitor_startedAt_idx" ON "monitor_incidents" USING btree ("monitor_id","started_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_monitor_incidents_fk" FOREIGN KEY ("monitor_incidents_id") REFERENCES "public"."monitor_incidents"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_monitor_incidents_id_idx" ON "payload_locked_documents_rels" USING btree ("monitor_incidents_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitor_incidents_timeline" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "monitor_incidents" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "monitor_incidents_timeline" CASCADE;
  DROP TABLE "monitor_incidents" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_monitor_incidents_fk";
  
  ALTER TABLE "notifications_events" ALTER COLUMN "value" SET DATA TYPE text;
  DROP TYPE "public"."enum_notifications_events";
  CREATE TYPE "public"."enum_notifications_events" AS ENUM('down', 'up', 'degraded', 'reminder', 'certificate', 'maintenance');
  ALTER TABLE "notifications_events" ALTER COLUMN "value" SET DATA TYPE "public"."enum_notifications_events" USING "value"::"public"."enum_notifications_events";
  DROP INDEX "payload_locked_documents_rels_monitor_incidents_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "monitor_incidents_id";
  DROP TYPE "public"."enum_monitor_incidents_timeline_type";
  DROP TYPE "public"."enum_monitor_incidents_timeline_via";
  DROP TYPE "public"."enum_monitor_incidents_status";
  DROP TYPE "public"."enum_monitor_incidents_acknowledged_via";`)
}
