import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_sla_targets_subject" AS ENUM('monitor', 'component', 'group');
  ALTER TYPE "public"."enum_sla_targets_calculation" ADD VALUE 'manual';
  CREATE TABLE "sla_targets_numbers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"number" numeric,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL
  );
  
  CREATE TABLE "sla_targets_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"notifications_id" integer
  );
  
  ALTER TABLE "sla_targets" ALTER COLUMN "monitor_id" DROP NOT NULL;
  ALTER TABLE "sla_targets" ADD COLUMN "subject" "enum_sla_targets_subject" DEFAULT 'monitor';
  ALTER TABLE "sla_targets" ADD COLUMN "status_page_id" integer;
  ALTER TABLE "sla_targets" ADD COLUMN "component" varchar;
  ALTER TABLE "sla_targets" ADD COLUMN "budget_alert_state" jsonb;
  ALTER TABLE "sla_targets_numbers" ADD CONSTRAINT "sla_targets_numbers_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sla_targets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sla_targets_rels" ADD CONSTRAINT "sla_targets_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sla_targets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sla_targets_rels" ADD CONSTRAINT "sla_targets_rels_notifications_fk" FOREIGN KEY ("notifications_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "sla_targets_numbers_order_parent_idx" ON "sla_targets_numbers" USING btree ("order","parent_id");
  CREATE INDEX "sla_targets_rels_order_idx" ON "sla_targets_rels" USING btree ("order");
  CREATE INDEX "sla_targets_rels_parent_idx" ON "sla_targets_rels" USING btree ("parent_id");
  CREATE INDEX "sla_targets_rels_path_idx" ON "sla_targets_rels" USING btree ("path");
  CREATE INDEX "sla_targets_rels_notifications_id_idx" ON "sla_targets_rels" USING btree ("notifications_id");
  ALTER TABLE "sla_targets" ADD CONSTRAINT "sla_targets_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "sla_targets_status_page_idx" ON "sla_targets" USING btree ("status_page_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "sla_targets_numbers" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "sla_targets_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "sla_targets_numbers" CASCADE;
  DROP TABLE "sla_targets_rels" CASCADE;
  ALTER TABLE "sla_targets" DROP CONSTRAINT "sla_targets_status_page_id_status_pages_id_fk";
  
  ALTER TABLE "sla_targets" ALTER COLUMN "calculation" SET DATA TYPE text;
  ALTER TABLE "sla_targets" ALTER COLUMN "calculation" SET DEFAULT 'duration'::text;
  DROP TYPE "public"."enum_sla_targets_calculation";
  CREATE TYPE "public"."enum_sla_targets_calculation" AS ENUM('duration', 'checks');
  ALTER TABLE "sla_targets" ALTER COLUMN "calculation" SET DEFAULT 'duration'::"public"."enum_sla_targets_calculation";
  ALTER TABLE "sla_targets" ALTER COLUMN "calculation" SET DATA TYPE "public"."enum_sla_targets_calculation" USING "calculation"::"public"."enum_sla_targets_calculation";
  DROP INDEX "sla_targets_status_page_idx";
  ALTER TABLE "sla_targets" ALTER COLUMN "monitor_id" SET NOT NULL;
  ALTER TABLE "sla_targets" DROP COLUMN "subject";
  ALTER TABLE "sla_targets" DROP COLUMN "status_page_id";
  ALTER TABLE "sla_targets" DROP COLUMN "component";
  ALTER TABLE "sla_targets" DROP COLUMN "budget_alert_state";
  DROP TYPE "public"."enum_sla_targets_subject";`)
}
