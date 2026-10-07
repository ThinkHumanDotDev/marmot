import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_maintenance_reminders" AS ENUM('15', '30', '60', '120', '360', '720', '1440', '2880', '10080');
  CREATE TYPE "public"."enum_maintenance_occurrences_reminders_sent" AS ENUM('15', '30', '60', '120', '360', '720', '1440', '2880', '10080');
  CREATE TYPE "public"."enum_maintenance_occurrences_updates_status" AS ENUM('scheduled', 'in-progress', 'verifying', 'completed', 'cancelled');
  CREATE TYPE "public"."enum_maintenance_occurrences_state" AS ENUM('scheduled', 'in-progress', 'verifying', 'completed', 'cancelled');
  CREATE TABLE "maintenance_reminders" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_maintenance_reminders",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "maintenance_occurrences_reminders_sent" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_maintenance_occurrences_reminders_sent",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "maintenance_occurrences_updates" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"status" "enum_maintenance_occurrences_updates_status" NOT NULL,
  	"posted_at" timestamp(3) with time zone NOT NULL,
  	"message" varchar
  );
  
  CREATE TABLE "maintenance_occurrences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"maintenance_id" integer NOT NULL,
  	"start" timestamp(3) with time zone NOT NULL,
  	"end" timestamp(3) with time zone,
  	"state" "enum_maintenance_occurrences_state" DEFAULT 'scheduled' NOT NULL,
  	"started_at" timestamp(3) with time zone,
  	"completed_at" timestamp(3) with time zone,
  	"cancelled_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "status_pages" ADD COLUMN "maintenance_visibility_hours" numeric DEFAULT 24;
  ALTER TABLE "maintenance" ADD COLUMN "auto_start" boolean DEFAULT true;
  ALTER TABLE "maintenance" ADD COLUMN "auto_complete" boolean DEFAULT true;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "maintenance_occurrences_id" integer;
  ALTER TABLE "maintenance_reminders" ADD CONSTRAINT "maintenance_reminders_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."maintenance"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "maintenance_occurrences_reminders_sent" ADD CONSTRAINT "maintenance_occurrences_reminders_sent_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."maintenance_occurrences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "maintenance_occurrences_updates" ADD CONSTRAINT "maintenance_occurrences_updates_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."maintenance_occurrences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "maintenance_occurrences" ADD CONSTRAINT "maintenance_occurrences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "maintenance_occurrences" ADD CONSTRAINT "maintenance_occurrences_maintenance_id_maintenance_id_fk" FOREIGN KEY ("maintenance_id") REFERENCES "public"."maintenance"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "maintenance_reminders_order_idx" ON "maintenance_reminders" USING btree ("order");
  CREATE INDEX "maintenance_reminders_parent_idx" ON "maintenance_reminders" USING btree ("parent_id");
  CREATE INDEX "maintenance_occurrences_reminders_sent_order_idx" ON "maintenance_occurrences_reminders_sent" USING btree ("order");
  CREATE INDEX "maintenance_occurrences_reminders_sent_parent_idx" ON "maintenance_occurrences_reminders_sent" USING btree ("parent_id");
  CREATE INDEX "maintenance_occurrences_updates_order_idx" ON "maintenance_occurrences_updates" USING btree ("_order");
  CREATE INDEX "maintenance_occurrences_updates_parent_id_idx" ON "maintenance_occurrences_updates" USING btree ("_parent_id");
  CREATE INDEX "maintenance_occurrences_organization_idx" ON "maintenance_occurrences" USING btree ("organization_id");
  CREATE INDEX "maintenance_occurrences_maintenance_idx" ON "maintenance_occurrences" USING btree ("maintenance_id");
  CREATE INDEX "maintenance_occurrences_start_idx" ON "maintenance_occurrences" USING btree ("start");
  CREATE INDEX "maintenance_occurrences_state_idx" ON "maintenance_occurrences" USING btree ("state");
  CREATE INDEX "maintenance_occurrences_updated_at_idx" ON "maintenance_occurrences" USING btree ("updated_at");
  CREATE INDEX "maintenance_occurrences_created_at_idx" ON "maintenance_occurrences" USING btree ("created_at");
  CREATE INDEX "maintenance_start_idx" ON "maintenance_occurrences" USING btree ("maintenance_id","start");
  CREATE INDEX "maintenance_state_idx" ON "maintenance_occurrences" USING btree ("maintenance_id","state");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_maintenance_occurrences_fk" FOREIGN KEY ("maintenance_occurrences_id") REFERENCES "public"."maintenance_occurrences"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_maintenance_occurrences_id_idx" ON "payload_locked_documents_rels" USING btree ("maintenance_occurrences_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "maintenance_reminders" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "maintenance_occurrences_reminders_sent" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "maintenance_occurrences_updates" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "maintenance_occurrences" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "maintenance_reminders" CASCADE;
  DROP TABLE "maintenance_occurrences_reminders_sent" CASCADE;
  DROP TABLE "maintenance_occurrences_updates" CASCADE;
  DROP TABLE "maintenance_occurrences" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_maintenance_occurrences_fk";
  
  DROP INDEX "payload_locked_documents_rels_maintenance_occurrences_id_idx";
  ALTER TABLE "status_pages" DROP COLUMN "maintenance_visibility_hours";
  ALTER TABLE "maintenance" DROP COLUMN "auto_start";
  ALTER TABLE "maintenance" DROP COLUMN "auto_complete";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "maintenance_occurrences_id";
  DROP TYPE "public"."enum_maintenance_reminders";
  DROP TYPE "public"."enum_maintenance_occurrences_reminders_sent";
  DROP TYPE "public"."enum_maintenance_occurrences_updates_status";
  DROP TYPE "public"."enum_maintenance_occurrences_state";`)
}
