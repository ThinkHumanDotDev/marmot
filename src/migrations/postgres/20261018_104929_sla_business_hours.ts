import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_sla_targets_business_hours_days" AS ENUM('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun');
  CREATE TABLE "sla_targets_business_hours_days" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_sla_targets_business_hours_days",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "sla_targets_business_hours_holidays" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"date" varchar NOT NULL
  );
  
  ALTER TABLE "sla_targets" ADD COLUMN "business_hours_enabled" boolean DEFAULT false;
  ALTER TABLE "sla_targets" ADD COLUMN "business_hours_start" varchar DEFAULT '09:00';
  ALTER TABLE "sla_targets" ADD COLUMN "business_hours_end" varchar DEFAULT '17:00';
  ALTER TABLE "sla_targets_business_hours_days" ADD CONSTRAINT "sla_targets_business_hours_days_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sla_targets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sla_targets_business_hours_holidays" ADD CONSTRAINT "sla_targets_business_hours_holidays_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."sla_targets"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "sla_targets_business_hours_days_order_idx" ON "sla_targets_business_hours_days" USING btree ("order");
  CREATE INDEX "sla_targets_business_hours_days_parent_idx" ON "sla_targets_business_hours_days" USING btree ("parent_id");
  CREATE INDEX "sla_targets_business_hours_holidays_order_idx" ON "sla_targets_business_hours_holidays" USING btree ("_order");
  CREATE INDEX "sla_targets_business_hours_holidays_parent_id_idx" ON "sla_targets_business_hours_holidays" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "sla_targets_business_hours_days" CASCADE;
  DROP TABLE "sla_targets_business_hours_holidays" CASCADE;
  ALTER TABLE "sla_targets" DROP COLUMN "business_hours_enabled";
  ALTER TABLE "sla_targets" DROP COLUMN "business_hours_start";
  ALTER TABLE "sla_targets" DROP COLUMN "business_hours_end";
  DROP TYPE "public"."enum_sla_targets_business_hours_days";`)
}
