import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_integrations_rules_match_operator" AS ENUM('equals', 'contains', 'regex');
  CREATE TYPE "public"."enum_integrations_rules_impact" AS ENUM('degraded_performance', 'partial_outage', 'major_outage');
  CREATE TYPE "public"."enum_integrations_rules_incident" AS ENUM('none', 'draft', 'publish');
  CREATE TYPE "public"."enum_integrations_rules_severity" AS ENUM('critical', 'major', 'minor');
  CREATE TYPE "public"."enum_integrations_format" AS ENUM('alertmanager', 'grafana', 'generic');
  CREATE TYPE "public"."enum_integration_alerts_status" AS ENUM('firing', 'resolved');
  CREATE TYPE "public"."enum_integration_events_source" AS ENUM('webhook', 'email');
  ALTER TYPE "public"."enum_push_events_source" ADD VALUE 'integration';
  CREATE TABLE "integrations_rules" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"enabled" boolean DEFAULT true,
  	"match_field" varchar,
  	"match_operator" "enum_integrations_rules_match_operator" DEFAULT 'equals',
  	"match_value" varchar,
  	"update_component" boolean DEFAULT false,
  	"status_page_id" integer,
  	"component" varchar,
  	"impact" "enum_integrations_rules_impact" DEFAULT 'partial_outage',
  	"incident" "enum_integrations_rules_incident" DEFAULT 'none',
  	"severity" "enum_integrations_rules_severity" DEFAULT 'major',
  	"monitor_id" integer
  );
  
  CREATE TABLE "integrations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"format" "enum_integrations_format" DEFAULT 'alertmanager' NOT NULL,
  	"active" boolean DEFAULT true,
  	"token_hash" varchar NOT NULL,
  	"token_prefix" varchar NOT NULL,
  	"generic_alerts_path" varchar DEFAULT '',
  	"generic_title_path" varchar DEFAULT 'title',
  	"generic_status_path" varchar DEFAULT 'status',
  	"generic_severity_path" varchar DEFAULT 'severity',
  	"generic_dedup_key_path" varchar DEFAULT 'id',
  	"generic_description_path" varchar DEFAULT 'message',
  	"generic_resolved_values" varchar DEFAULT 'resolved,ok,recovered,closed,inactive',
  	"email_resolved_keyword" varchar DEFAULT 'resolved',
  	"last_event_at" timestamp(3) with time zone,
  	"created_by_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "integration_alerts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"integration_id" integer NOT NULL,
  	"dedup_key" varchar NOT NULL,
  	"status" "enum_integration_alerts_status" DEFAULT 'firing' NOT NULL,
  	"title" varchar,
  	"rule" varchar,
  	"fired_at" timestamp(3) with time zone,
  	"resolved_at" timestamp(3) with time zone,
  	"last_event_at" timestamp(3) with time zone,
  	"status_page_incident_id" integer,
  	"declared_incident_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "integration_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"integration_id" integer NOT NULL,
  	"received_at" timestamp(3) with time zone NOT NULL,
  	"source" "enum_integration_events_source" DEFAULT 'webhook' NOT NULL,
  	"alert_count" numeric DEFAULT 0,
  	"dropped_count" numeric DEFAULT 0,
  	"payload" varchar,
  	"results" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "integrations_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "integration_alerts_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "integration_events_id" integer;
  ALTER TABLE "integrations_rules" ADD CONSTRAINT "integrations_rules_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "integrations_rules" ADD CONSTRAINT "integrations_rules_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "integrations_rules" ADD CONSTRAINT "integrations_rules_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "integrations" ADD CONSTRAINT "integrations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "integration_alerts" ADD CONSTRAINT "integration_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "integration_alerts" ADD CONSTRAINT "integration_alerts_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "integration_alerts" ADD CONSTRAINT "integration_alerts_status_page_incident_id_incidents_id_fk" FOREIGN KEY ("status_page_incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "integration_alerts" ADD CONSTRAINT "integration_alerts_declared_incident_id_declared_incidents_id_fk" FOREIGN KEY ("declared_incident_id") REFERENCES "public"."declared_incidents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "integrations_rules_order_idx" ON "integrations_rules" USING btree ("_order");
  CREATE INDEX "integrations_rules_parent_id_idx" ON "integrations_rules" USING btree ("_parent_id");
  CREATE INDEX "integrations_rules_status_page_idx" ON "integrations_rules" USING btree ("status_page_id");
  CREATE INDEX "integrations_rules_monitor_idx" ON "integrations_rules" USING btree ("monitor_id");
  CREATE INDEX "integrations_organization_idx" ON "integrations" USING btree ("organization_id");
  CREATE UNIQUE INDEX "integrations_token_hash_idx" ON "integrations" USING btree ("token_hash");
  CREATE INDEX "integrations_created_by_idx" ON "integrations" USING btree ("created_by_id");
  CREATE INDEX "integrations_updated_at_idx" ON "integrations" USING btree ("updated_at");
  CREATE INDEX "integrations_created_at_idx" ON "integrations" USING btree ("created_at");
  CREATE INDEX "integration_alerts_organization_idx" ON "integration_alerts" USING btree ("organization_id");
  CREATE INDEX "integration_alerts_integration_idx" ON "integration_alerts" USING btree ("integration_id");
  CREATE INDEX "integration_alerts_status_page_incident_idx" ON "integration_alerts" USING btree ("status_page_incident_id");
  CREATE INDEX "integration_alerts_declared_incident_idx" ON "integration_alerts" USING btree ("declared_incident_id");
  CREATE INDEX "integration_alerts_updated_at_idx" ON "integration_alerts" USING btree ("updated_at");
  CREATE INDEX "integration_alerts_created_at_idx" ON "integration_alerts" USING btree ("created_at");
  CREATE UNIQUE INDEX "integration_dedupKey_idx" ON "integration_alerts" USING btree ("integration_id","dedup_key");
  CREATE INDEX "integration_events_organization_idx" ON "integration_events" USING btree ("organization_id");
  CREATE INDEX "integration_events_integration_idx" ON "integration_events" USING btree ("integration_id");
  CREATE INDEX "integration_events_updated_at_idx" ON "integration_events" USING btree ("updated_at");
  CREATE INDEX "integration_events_created_at_idx" ON "integration_events" USING btree ("created_at");
  CREATE INDEX "integration_receivedAt_idx" ON "integration_events" USING btree ("integration_id","received_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_integrations_fk" FOREIGN KEY ("integrations_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_integration_alerts_fk" FOREIGN KEY ("integration_alerts_id") REFERENCES "public"."integration_alerts"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_integration_events_fk" FOREIGN KEY ("integration_events_id") REFERENCES "public"."integration_events"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_integrations_id_idx" ON "payload_locked_documents_rels" USING btree ("integrations_id");
  CREATE INDEX "payload_locked_documents_rels_integration_alerts_id_idx" ON "payload_locked_documents_rels" USING btree ("integration_alerts_id");
  CREATE INDEX "payload_locked_documents_rels_integration_events_id_idx" ON "payload_locked_documents_rels" USING btree ("integration_events_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "integrations_rules" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "integrations" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "integration_alerts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "integration_events" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "integrations_rules" CASCADE;
  DROP TABLE "integrations" CASCADE;
  DROP TABLE "integration_alerts" CASCADE;
  DROP TABLE "integration_events" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_integrations_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_integration_alerts_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_integration_events_fk";
  
  ALTER TABLE "push_events" ALTER COLUMN "source" SET DATA TYPE text;
  ALTER TABLE "push_events" ALTER COLUMN "source" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_push_events_source";
  CREATE TYPE "public"."enum_push_events_source" AS ENUM('http', 'email');
  ALTER TABLE "push_events" ALTER COLUMN "source" SET DEFAULT 'http'::"public"."enum_push_events_source";
  ALTER TABLE "push_events" ALTER COLUMN "source" SET DATA TYPE "public"."enum_push_events_source" USING "source"::"public"."enum_push_events_source";
  DROP INDEX "payload_locked_documents_rels_integrations_id_idx";
  DROP INDEX "payload_locked_documents_rels_integration_alerts_id_idx";
  DROP INDEX "payload_locked_documents_rels_integration_events_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "integrations_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "integration_alerts_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "integration_events_id";
  DROP TYPE "public"."enum_integrations_rules_match_operator";
  DROP TYPE "public"."enum_integrations_rules_impact";
  DROP TYPE "public"."enum_integrations_rules_incident";
  DROP TYPE "public"."enum_integrations_rules_severity";
  DROP TYPE "public"."enum_integrations_format";
  DROP TYPE "public"."enum_integration_alerts_status";
  DROP TYPE "public"."enum_integration_events_source";`)
}
