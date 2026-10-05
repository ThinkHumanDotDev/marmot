import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "organizations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "monitors" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "stat_minutely" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"timestamp" numeric NOT NULL,
  	"up" numeric DEFAULT 0 NOT NULL,
  	"down" numeric DEFAULT 0 NOT NULL,
  	"ping" numeric,
  	"ping_min" numeric,
  	"ping_max" numeric,
  	"extras" jsonb
  );
  
  CREATE TABLE "stat_hourly" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"timestamp" numeric NOT NULL,
  	"up" numeric DEFAULT 0 NOT NULL,
  	"down" numeric DEFAULT 0 NOT NULL,
  	"ping" numeric,
  	"ping_min" numeric,
  	"ping_max" numeric,
  	"extras" jsonb
  );
  
  CREATE TABLE "stat_daily" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"timestamp" numeric NOT NULL,
  	"up" numeric DEFAULT 0 NOT NULL,
  	"down" numeric DEFAULT 0 NOT NULL,
  	"ping" numeric,
  	"ping_min" numeric,
  	"ping_max" numeric,
  	"extras" jsonb
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "organizations_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "monitors_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "stat_minutely_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "stat_hourly_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "stat_daily_id" integer;
  ALTER TABLE "stat_minutely" ADD CONSTRAINT "stat_minutely_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "stat_minutely" ADD CONSTRAINT "stat_minutely_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "stat_hourly" ADD CONSTRAINT "stat_hourly_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "stat_hourly" ADD CONSTRAINT "stat_hourly_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "stat_daily" ADD CONSTRAINT "stat_daily_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "stat_daily" ADD CONSTRAINT "stat_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "organizations_updated_at_idx" ON "organizations" USING btree ("updated_at");
  CREATE INDEX "organizations_created_at_idx" ON "organizations" USING btree ("created_at");
  CREATE INDEX "monitors_updated_at_idx" ON "monitors" USING btree ("updated_at");
  CREATE INDEX "monitors_created_at_idx" ON "monitors" USING btree ("created_at");
  CREATE INDEX "stat_minutely_monitor_idx" ON "stat_minutely" USING btree ("monitor_id");
  CREATE INDEX "stat_minutely_organization_idx" ON "stat_minutely" USING btree ("organization_id");
  CREATE INDEX "stat_minutely_timestamp_idx" ON "stat_minutely" USING btree ("timestamp");
  CREATE UNIQUE INDEX "monitor_timestamp_idx" ON "stat_minutely" USING btree ("monitor_id","timestamp");
  CREATE INDEX "stat_hourly_monitor_idx" ON "stat_hourly" USING btree ("monitor_id");
  CREATE INDEX "stat_hourly_organization_idx" ON "stat_hourly" USING btree ("organization_id");
  CREATE INDEX "stat_hourly_timestamp_idx" ON "stat_hourly" USING btree ("timestamp");
  CREATE UNIQUE INDEX "monitor_timestamp_1_idx" ON "stat_hourly" USING btree ("monitor_id","timestamp");
  CREATE INDEX "stat_daily_monitor_idx" ON "stat_daily" USING btree ("monitor_id");
  CREATE INDEX "stat_daily_organization_idx" ON "stat_daily" USING btree ("organization_id");
  CREATE INDEX "stat_daily_timestamp_idx" ON "stat_daily" USING btree ("timestamp");
  CREATE UNIQUE INDEX "monitor_timestamp_2_idx" ON "stat_daily" USING btree ("monitor_id","timestamp");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_organizations_fk" FOREIGN KEY ("organizations_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_monitors_fk" FOREIGN KEY ("monitors_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_stat_minutely_fk" FOREIGN KEY ("stat_minutely_id") REFERENCES "public"."stat_minutely"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_stat_hourly_fk" FOREIGN KEY ("stat_hourly_id") REFERENCES "public"."stat_hourly"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_stat_daily_fk" FOREIGN KEY ("stat_daily_id") REFERENCES "public"."stat_daily"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_organizations_id_idx" ON "payload_locked_documents_rels" USING btree ("organizations_id");
  CREATE INDEX "payload_locked_documents_rels_monitors_id_idx" ON "payload_locked_documents_rels" USING btree ("monitors_id");
  CREATE INDEX "payload_locked_documents_rels_stat_minutely_id_idx" ON "payload_locked_documents_rels" USING btree ("stat_minutely_id");
  CREATE INDEX "payload_locked_documents_rels_stat_hourly_id_idx" ON "payload_locked_documents_rels" USING btree ("stat_hourly_id");
  CREATE INDEX "payload_locked_documents_rels_stat_daily_id_idx" ON "payload_locked_documents_rels" USING btree ("stat_daily_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "organizations" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "monitors" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "stat_minutely" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "stat_hourly" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "stat_daily" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "organizations" CASCADE;
  DROP TABLE "monitors" CASCADE;
  DROP TABLE "stat_minutely" CASCADE;
  DROP TABLE "stat_hourly" CASCADE;
  DROP TABLE "stat_daily" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_organizations_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_monitors_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_stat_minutely_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_stat_hourly_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_stat_daily_fk";
  
  DROP INDEX "payload_locked_documents_rels_organizations_id_idx";
  DROP INDEX "payload_locked_documents_rels_monitors_id_idx";
  DROP INDEX "payload_locked_documents_rels_stat_minutely_id_idx";
  DROP INDEX "payload_locked_documents_rels_stat_hourly_id_idx";
  DROP INDEX "payload_locked_documents_rels_stat_daily_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "organizations_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "monitors_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "stat_minutely_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "stat_hourly_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "stat_daily_id";`)
}
