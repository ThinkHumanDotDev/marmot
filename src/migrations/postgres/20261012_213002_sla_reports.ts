import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_sla_targets_period" AS ENUM('month', 'quarter', 'rolling30');
  CREATE TYPE "public"."enum_sla_targets_calculation" AS ENUM('duration', 'checks');
  CREATE TYPE "public"."enum_sla_reports_schedule" AS ENUM('none', 'weekly', 'monthly');
  CREATE TABLE "sla_targets" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"target" numeric NOT NULL,
  	"period" "enum_sla_targets_period" DEFAULT 'month' NOT NULL,
  	"calculation" "enum_sla_targets_calculation" DEFAULT 'duration' NOT NULL,
  	"exclude_maintenance" boolean DEFAULT true,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "sla_reports_recipients" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"email" varchar NOT NULL
  );
  
  CREATE TABLE "sla_reports" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"schedule" "enum_sla_reports_schedule" DEFAULT 'none' NOT NULL,
  	"last_sent_period" varchar,
  	"last_sent_at" timestamp(3) with time zone,
  	"last_error" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "sla_reports_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"sla_targets_id" integer
  );
  
  CREATE TABLE "sla_report_shares" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"report_id" integer NOT NULL,
  	"token_hash" varchar NOT NULL,
  	"from_date" varchar NOT NULL,
  	"to_date" varchar NOT NULL,
  	"created_by_id" integer,
  	"revoked_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "sla_targets_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "sla_reports_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "sla_report_shares_id" integer;
  ALTER TABLE "sla_targets" ADD CONSTRAINT "sla_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sla_targets" ADD CONSTRAINT "sla_targets_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sla_reports_recipients" ADD CONSTRAINT "sla_reports_recipients_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."sla_reports"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sla_reports" ADD CONSTRAINT "sla_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sla_reports_rels" ADD CONSTRAINT "sla_reports_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sla_reports"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sla_reports_rels" ADD CONSTRAINT "sla_reports_rels_sla_targets_fk" FOREIGN KEY ("sla_targets_id") REFERENCES "public"."sla_targets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "sla_report_shares" ADD CONSTRAINT "sla_report_shares_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sla_report_shares" ADD CONSTRAINT "sla_report_shares_report_id_sla_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."sla_reports"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sla_report_shares" ADD CONSTRAINT "sla_report_shares_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "sla_targets_organization_idx" ON "sla_targets" USING btree ("organization_id");
  CREATE INDEX "sla_targets_monitor_idx" ON "sla_targets" USING btree ("monitor_id");
  CREATE INDEX "sla_targets_updated_at_idx" ON "sla_targets" USING btree ("updated_at");
  CREATE INDEX "sla_targets_created_at_idx" ON "sla_targets" USING btree ("created_at");
  CREATE INDEX "sla_reports_recipients_order_idx" ON "sla_reports_recipients" USING btree ("_order");
  CREATE INDEX "sla_reports_recipients_parent_id_idx" ON "sla_reports_recipients" USING btree ("_parent_id");
  CREATE INDEX "sla_reports_organization_idx" ON "sla_reports" USING btree ("organization_id");
  CREATE INDEX "sla_reports_updated_at_idx" ON "sla_reports" USING btree ("updated_at");
  CREATE INDEX "sla_reports_created_at_idx" ON "sla_reports" USING btree ("created_at");
  CREATE INDEX "sla_reports_rels_order_idx" ON "sla_reports_rels" USING btree ("order");
  CREATE INDEX "sla_reports_rels_parent_idx" ON "sla_reports_rels" USING btree ("parent_id");
  CREATE INDEX "sla_reports_rels_path_idx" ON "sla_reports_rels" USING btree ("path");
  CREATE INDEX "sla_reports_rels_sla_targets_id_idx" ON "sla_reports_rels" USING btree ("sla_targets_id");
  CREATE INDEX "sla_report_shares_organization_idx" ON "sla_report_shares" USING btree ("organization_id");
  CREATE INDEX "sla_report_shares_report_idx" ON "sla_report_shares" USING btree ("report_id");
  CREATE UNIQUE INDEX "sla_report_shares_token_hash_idx" ON "sla_report_shares" USING btree ("token_hash");
  CREATE INDEX "sla_report_shares_created_by_idx" ON "sla_report_shares" USING btree ("created_by_id");
  CREATE INDEX "sla_report_shares_revoked_at_idx" ON "sla_report_shares" USING btree ("revoked_at");
  CREATE INDEX "sla_report_shares_updated_at_idx" ON "sla_report_shares" USING btree ("updated_at");
  CREATE INDEX "sla_report_shares_created_at_idx" ON "sla_report_shares" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sla_targets_fk" FOREIGN KEY ("sla_targets_id") REFERENCES "public"."sla_targets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sla_reports_fk" FOREIGN KEY ("sla_reports_id") REFERENCES "public"."sla_reports"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sla_report_shares_fk" FOREIGN KEY ("sla_report_shares_id") REFERENCES "public"."sla_report_shares"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_sla_targets_id_idx" ON "payload_locked_documents_rels" USING btree ("sla_targets_id");
  CREATE INDEX "payload_locked_documents_rels_sla_reports_id_idx" ON "payload_locked_documents_rels" USING btree ("sla_reports_id");
  CREATE INDEX "payload_locked_documents_rels_sla_report_shares_id_idx" ON "payload_locked_documents_rels" USING btree ("sla_report_shares_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "sla_targets" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "sla_reports_recipients" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "sla_reports" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "sla_reports_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "sla_report_shares" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "sla_targets" CASCADE;
  DROP TABLE "sla_reports_recipients" CASCADE;
  DROP TABLE "sla_reports" CASCADE;
  DROP TABLE "sla_reports_rels" CASCADE;
  DROP TABLE "sla_report_shares" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_sla_targets_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_sla_reports_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_sla_report_shares_fk";
  
  DROP INDEX "payload_locked_documents_rels_sla_targets_id_idx";
  DROP INDEX "payload_locked_documents_rels_sla_reports_id_idx";
  DROP INDEX "payload_locked_documents_rels_sla_report_shares_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "sla_targets_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "sla_reports_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "sla_report_shares_id";
  DROP TYPE "public"."enum_sla_targets_period";
  DROP TYPE "public"."enum_sla_targets_calculation";
  DROP TYPE "public"."enum_sla_reports_schedule";`)
}
