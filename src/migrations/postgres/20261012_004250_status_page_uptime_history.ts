import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_status_pages_uptime_calculation" AS ENUM('checks', 'duration', 'manual');
  CREATE TYPE "public"."enum_status_page_uptime_history_state" AS ENUM('nodata', 'up', 'maintenance', 'degraded', 'partial', 'down');
  CREATE TABLE "status_page_uptime_history" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"status_page_id" integer NOT NULL,
  	"component" varchar NOT NULL,
  	"timestamp" numeric NOT NULL,
  	"day" varchar NOT NULL,
  	"month" varchar NOT NULL,
  	"up" numeric DEFAULT 0 NOT NULL,
  	"down" numeric DEFAULT 0 NOT NULL,
  	"degraded" numeric DEFAULT 0,
  	"maintenance" numeric DEFAULT 0,
  	"down_seconds" numeric DEFAULT 0,
  	"known_seconds" numeric DEFAULT 0,
  	"state" "enum_status_page_uptime_history_state" DEFAULT 'up' NOT NULL
  );
  
  ALTER TABLE "status_pages" ADD COLUMN "uptime_bar_days" numeric DEFAULT 90;
  ALTER TABLE "status_pages" ADD COLUMN "uptime_calculation" "enum_status_pages_uptime_calculation" DEFAULT 'checks';
  ALTER TABLE "status_pages" ADD COLUMN "show_uptime_percentage" boolean DEFAULT true;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "status_page_uptime_history_id" integer;
  ALTER TABLE "status_page_uptime_history" ADD CONSTRAINT "status_page_uptime_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "status_page_uptime_history" ADD CONSTRAINT "status_page_uptime_history_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "status_page_uptime_history_organization_idx" ON "status_page_uptime_history" USING btree ("organization_id");
  CREATE INDEX "status_page_uptime_history_status_page_idx" ON "status_page_uptime_history" USING btree ("status_page_id");
  CREATE INDEX "status_page_uptime_history_component_idx" ON "status_page_uptime_history" USING btree ("component");
  CREATE INDEX "status_page_uptime_history_timestamp_idx" ON "status_page_uptime_history" USING btree ("timestamp");
  CREATE INDEX "status_page_uptime_history_month_idx" ON "status_page_uptime_history" USING btree ("month");
  CREATE UNIQUE INDEX "statusPage_component_timestamp_idx" ON "status_page_uptime_history" USING btree ("status_page_id","component","timestamp");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_status_page_uptime_history_fk" FOREIGN KEY ("status_page_uptime_history_id") REFERENCES "public"."status_page_uptime_history"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_status_page_uptime_history_idx" ON "payload_locked_documents_rels" USING btree ("status_page_uptime_history_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_page_uptime_history" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "status_page_uptime_history" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_status_page_uptime_history_fk";
  
  DROP INDEX "payload_locked_documents_rels_status_page_uptime_history_idx";
  ALTER TABLE "status_pages" DROP COLUMN "uptime_bar_days";
  ALTER TABLE "status_pages" DROP COLUMN "uptime_calculation";
  ALTER TABLE "status_pages" DROP COLUMN "show_uptime_percentage";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "status_page_uptime_history_id";
  DROP TYPE "public"."enum_status_pages_uptime_calculation";
  DROP TYPE "public"."enum_status_page_uptime_history_state";`)
}
