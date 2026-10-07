import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_incidents_updates_components_impact" AS ENUM('operational', 'degraded_performance', 'partial_outage', 'major_outage');
  CREATE TYPE "public"."enum_incidents_updates_status" AS ENUM('investigating', 'identified', 'monitoring', 'resolved');
  CREATE TYPE "public"."enum_incidents_affected_monitors_impact" AS ENUM('operational', 'degraded_performance', 'partial_outage', 'major_outage');
  CREATE TYPE "public"."enum_incidents_status" AS ENUM('investigating', 'identified', 'monitoring', 'resolved');
  CREATE TYPE "public"."enum_incidents_impact" AS ENUM('operational', 'degraded_performance', 'partial_outage', 'major_outage');
  CREATE TABLE "incidents_updates_components" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"monitor_id" integer,
  	"impact" "enum_incidents_updates_components_impact" DEFAULT 'major_outage' NOT NULL
  );
  
  CREATE TABLE "incidents_updates" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"status" "enum_incidents_updates_status" DEFAULT 'investigating' NOT NULL,
  	"posted_at" timestamp(3) with time zone NOT NULL,
  	"edited_at" timestamp(3) with time zone,
  	"message" varchar
  );
  
  CREATE TABLE "incidents_affected_monitors" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"monitor_id" integer,
  	"impact" "enum_incidents_affected_monitors_impact" DEFAULT 'major_outage' NOT NULL
  );
  
  ALTER TABLE "incidents" ADD COLUMN "status" "enum_incidents_status";
  ALTER TABLE "incidents" ADD COLUMN "impact" "enum_incidents_impact";
  ALTER TABLE "incidents_updates_components" ADD CONSTRAINT "incidents_updates_components_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "incidents_updates_components" ADD CONSTRAINT "incidents_updates_components_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."incidents_updates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "incidents_updates" ADD CONSTRAINT "incidents_updates_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "incidents_affected_monitors" ADD CONSTRAINT "incidents_affected_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "incidents_affected_monitors" ADD CONSTRAINT "incidents_affected_monitors_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "incidents_updates_components_order_idx" ON "incidents_updates_components" USING btree ("_order");
  CREATE INDEX "incidents_updates_components_parent_id_idx" ON "incidents_updates_components" USING btree ("_parent_id");
  CREATE INDEX "incidents_updates_components_monitor_idx" ON "incidents_updates_components" USING btree ("monitor_id");
  CREATE INDEX "incidents_updates_order_idx" ON "incidents_updates" USING btree ("_order");
  CREATE INDEX "incidents_updates_parent_id_idx" ON "incidents_updates" USING btree ("_parent_id");
  CREATE INDEX "incidents_affected_monitors_order_idx" ON "incidents_affected_monitors" USING btree ("_order");
  CREATE INDEX "incidents_affected_monitors_parent_id_idx" ON "incidents_affected_monitors" USING btree ("_parent_id");
  CREATE INDEX "incidents_affected_monitors_monitor_idx" ON "incidents_affected_monitors" USING btree ("monitor_id");
  CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "incidents_updates_components" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "incidents_updates" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "incidents_affected_monitors" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "incidents_updates_components" CASCADE;
  DROP TABLE "incidents_updates" CASCADE;
  DROP TABLE "incidents_affected_monitors" CASCADE;
  DROP INDEX "incidents_status_idx";
  ALTER TABLE "incidents" DROP COLUMN "status";
  ALTER TABLE "incidents" DROP COLUMN "impact";
  DROP TYPE "public"."enum_incidents_updates_components_impact";
  DROP TYPE "public"."enum_incidents_updates_status";
  DROP TYPE "public"."enum_incidents_affected_monitors_impact";
  DROP TYPE "public"."enum_incidents_status";
  DROP TYPE "public"."enum_incidents_impact";`)
}
