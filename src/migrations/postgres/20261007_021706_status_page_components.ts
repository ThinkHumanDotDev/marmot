import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_status_pages_groups_monitors_type" AS ENUM('monitor', 'static');
  CREATE TYPE "public"."enum_incidents_affected_components_impact" AS ENUM('operational', 'degraded_performance', 'partial_outage', 'major_outage');
  CREATE TABLE "incidents_affected_components" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"component" varchar NOT NULL,
  	"impact" "enum_incidents_affected_components_impact" DEFAULT 'partial_outage' NOT NULL
  );
  
  ALTER TABLE "status_pages_groups_monitors" ALTER COLUMN "monitor_id" DROP NOT NULL;
  ALTER TABLE "monitors" ADD COLUMN "public_name" varchar;
  ALTER TABLE "status_pages_groups_monitors" ADD COLUMN "type" "enum_status_pages_groups_monitors_type" DEFAULT 'monitor';
  ALTER TABLE "status_pages_groups_monitors" ADD COLUMN "name" varchar;
  ALTER TABLE "status_pages_groups_monitors" ADD COLUMN "description" varchar;
  ALTER TABLE "status_pages_groups_monitors" ADD COLUMN "show_values" boolean DEFAULT true;
  ALTER TABLE "status_pages_groups" ADD COLUMN "default_open" boolean DEFAULT true;
  ALTER TABLE "status_pages" ADD COLUMN "homepage_url" varchar;
  ALTER TABLE "status_pages" ADD COLUMN "contact_url" varchar;
  ALTER TABLE "status_pages" ADD COLUMN "show_values" boolean DEFAULT true;
  ALTER TABLE "incidents_affected_components" ADD CONSTRAINT "incidents_affected_components_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "incidents_affected_components_order_idx" ON "incidents_affected_components" USING btree ("_order");
  CREATE INDEX "incidents_affected_components_parent_id_idx" ON "incidents_affected_components" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "incidents_affected_components" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "incidents_affected_components" CASCADE;
  ALTER TABLE "status_pages_groups_monitors" ALTER COLUMN "monitor_id" SET NOT NULL;
  ALTER TABLE "monitors" DROP COLUMN "public_name";
  ALTER TABLE "status_pages_groups_monitors" DROP COLUMN "type";
  ALTER TABLE "status_pages_groups_monitors" DROP COLUMN "name";
  ALTER TABLE "status_pages_groups_monitors" DROP COLUMN "description";
  ALTER TABLE "status_pages_groups_monitors" DROP COLUMN "show_values";
  ALTER TABLE "status_pages_groups" DROP COLUMN "default_open";
  ALTER TABLE "status_pages" DROP COLUMN "homepage_url";
  ALTER TABLE "status_pages" DROP COLUMN "contact_url";
  ALTER TABLE "status_pages" DROP COLUMN "show_values";
  DROP TYPE "public"."enum_status_pages_groups_monitors_type";
  DROP TYPE "public"."enum_incidents_affected_components_impact";`)
}
