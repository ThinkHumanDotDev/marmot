import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_maintenance_weekdays" AS ENUM('1', '2', '3', '4', '5', '6', '0');
  CREATE TYPE "public"."enum_maintenance_days_of_month" AS ENUM('1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', 'lastDay1', 'lastDay2', 'lastDay3', 'lastDay4');
  CREATE TYPE "public"."enum_maintenance_strategy" AS ENUM('manual', 'single', 'recurring-interval', 'recurring-weekday', 'recurring-day-of-month', 'cron');
  CREATE TYPE "public"."enum_maintenance_status" AS ENUM('inactive', 'scheduled', 'under-maintenance', 'ended', 'unknown');
  CREATE TABLE "maintenance_weekdays" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_maintenance_weekdays",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "maintenance_days_of_month" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_maintenance_days_of_month",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "maintenance" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"title" varchar NOT NULL,
  	"description" varchar,
  	"strategy" "enum_maintenance_strategy" DEFAULT 'single' NOT NULL,
  	"timezone" varchar DEFAULT 'SAME_AS_SERVER',
  	"active" boolean DEFAULT true,
  	"status" "enum_maintenance_status" DEFAULT 'unknown',
  	"date_range_start" varchar,
  	"date_range_end" varchar,
  	"time_range_start" varchar DEFAULT '02:00',
  	"time_range_end" varchar DEFAULT '03:00',
  	"interval_day" numeric DEFAULT 1,
  	"cron" varchar DEFAULT '30 3 * * *',
  	"duration" numeric DEFAULT 60,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "maintenance_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"monitors_id" integer,
  	"status_pages_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "maintenance_id" integer;
  ALTER TABLE "maintenance_weekdays" ADD CONSTRAINT "maintenance_weekdays_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."maintenance"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "maintenance_days_of_month" ADD CONSTRAINT "maintenance_days_of_month_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."maintenance"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "maintenance" ADD CONSTRAINT "maintenance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "maintenance_rels" ADD CONSTRAINT "maintenance_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."maintenance"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "maintenance_rels" ADD CONSTRAINT "maintenance_rels_monitors_fk" FOREIGN KEY ("monitors_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "maintenance_rels" ADD CONSTRAINT "maintenance_rels_status_pages_fk" FOREIGN KEY ("status_pages_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "maintenance_weekdays_order_idx" ON "maintenance_weekdays" USING btree ("order");
  CREATE INDEX "maintenance_weekdays_parent_idx" ON "maintenance_weekdays" USING btree ("parent_id");
  CREATE INDEX "maintenance_days_of_month_order_idx" ON "maintenance_days_of_month" USING btree ("order");
  CREATE INDEX "maintenance_days_of_month_parent_idx" ON "maintenance_days_of_month" USING btree ("parent_id");
  CREATE INDEX "maintenance_organization_idx" ON "maintenance" USING btree ("organization_id");
  CREATE INDEX "maintenance_active_idx" ON "maintenance" USING btree ("active");
  CREATE INDEX "maintenance_status_idx" ON "maintenance" USING btree ("status");
  CREATE INDEX "maintenance_updated_at_idx" ON "maintenance" USING btree ("updated_at");
  CREATE INDEX "maintenance_created_at_idx" ON "maintenance" USING btree ("created_at");
  CREATE INDEX "organization_active_1_idx" ON "maintenance" USING btree ("organization_id","active");
  CREATE INDEX "maintenance_rels_order_idx" ON "maintenance_rels" USING btree ("order");
  CREATE INDEX "maintenance_rels_parent_idx" ON "maintenance_rels" USING btree ("parent_id");
  CREATE INDEX "maintenance_rels_path_idx" ON "maintenance_rels" USING btree ("path");
  CREATE INDEX "maintenance_rels_monitors_id_idx" ON "maintenance_rels" USING btree ("monitors_id");
  CREATE INDEX "maintenance_rels_status_pages_id_idx" ON "maintenance_rels" USING btree ("status_pages_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_maintenance_fk" FOREIGN KEY ("maintenance_id") REFERENCES "public"."maintenance"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_maintenance_id_idx" ON "payload_locked_documents_rels" USING btree ("maintenance_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "maintenance_weekdays" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "maintenance_days_of_month" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "maintenance" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "maintenance_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "maintenance_weekdays" CASCADE;
  DROP TABLE "maintenance_days_of_month" CASCADE;
  DROP TABLE "maintenance" CASCADE;
  DROP TABLE "maintenance_rels" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_maintenance_fk";
  
  DROP INDEX "payload_locked_documents_rels_maintenance_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "maintenance_id";
  DROP TYPE "public"."enum_maintenance_weekdays";
  DROP TYPE "public"."enum_maintenance_days_of_month";
  DROP TYPE "public"."enum_maintenance_strategy";
  DROP TYPE "public"."enum_maintenance_status";`)
}
