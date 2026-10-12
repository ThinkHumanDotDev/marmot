import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_metrics_aggregation" AS ENUM('average', 'sum', 'last', 'max');
  CREATE TYPE "public"."enum_metrics_default_view" AS ENUM('hour', 'day', 'week', 'month');
  CREATE TYPE "public"."enum_metrics_source" AS ENUM('push', 'monitor');
  CREATE TYPE "public"."enum_metric_stats_granularity" AS ENUM('minute', 'hour', 'day');
  CREATE TABLE "metrics" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"description" varchar,
  	"suffix" varchar,
  	"decimals" numeric DEFAULT 0 NOT NULL,
  	"aggregation" "enum_metrics_aggregation" DEFAULT 'average' NOT NULL,
  	"default_view" "enum_metrics_default_view" DEFAULT 'day' NOT NULL,
  	"thresholds_warning" numeric,
  	"thresholds_critical" numeric,
  	"source" "enum_metrics_source" DEFAULT 'push' NOT NULL,
  	"monitor_id" integer,
  	"visible" boolean DEFAULT false,
  	"order" numeric DEFAULT 0,
  	"last_value" numeric,
  	"last_push_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "metrics_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"status_pages_id" integer
  );
  
  CREATE TABLE "metric_stats" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"metric_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"granularity" "enum_metric_stats_granularity" NOT NULL,
  	"timestamp" numeric NOT NULL,
  	"count" numeric DEFAULT 0 NOT NULL,
  	"sum" numeric DEFAULT 0 NOT NULL,
  	"min" numeric NOT NULL,
  	"max" numeric NOT NULL,
  	"last" numeric NOT NULL,
  	"last_at" numeric NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "metrics_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "metric_stats_id" integer;
  ALTER TABLE "metrics" ADD CONSTRAINT "metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "metrics" ADD CONSTRAINT "metrics_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "metrics_rels" ADD CONSTRAINT "metrics_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."metrics"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "metrics_rels" ADD CONSTRAINT "metrics_rels_status_pages_fk" FOREIGN KEY ("status_pages_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "metric_stats" ADD CONSTRAINT "metric_stats_metric_id_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metrics"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "metric_stats" ADD CONSTRAINT "metric_stats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "metrics_organization_idx" ON "metrics" USING btree ("organization_id");
  CREATE INDEX "metrics_monitor_idx" ON "metrics" USING btree ("monitor_id");
  CREATE INDEX "metrics_visible_idx" ON "metrics" USING btree ("visible");
  CREATE INDEX "metrics_updated_at_idx" ON "metrics" USING btree ("updated_at");
  CREATE INDEX "metrics_created_at_idx" ON "metrics" USING btree ("created_at");
  CREATE INDEX "metrics_rels_order_idx" ON "metrics_rels" USING btree ("order");
  CREATE INDEX "metrics_rels_parent_idx" ON "metrics_rels" USING btree ("parent_id");
  CREATE INDEX "metrics_rels_path_idx" ON "metrics_rels" USING btree ("path");
  CREATE INDEX "metrics_rels_status_pages_id_idx" ON "metrics_rels" USING btree ("status_pages_id");
  CREATE INDEX "metric_stats_metric_idx" ON "metric_stats" USING btree ("metric_id");
  CREATE INDEX "metric_stats_organization_idx" ON "metric_stats" USING btree ("organization_id");
  CREATE INDEX "metric_stats_granularity_idx" ON "metric_stats" USING btree ("granularity");
  CREATE INDEX "metric_stats_timestamp_idx" ON "metric_stats" USING btree ("timestamp");
  CREATE UNIQUE INDEX "metric_granularity_timestamp_idx" ON "metric_stats" USING btree ("metric_id","granularity","timestamp");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_metrics_fk" FOREIGN KEY ("metrics_id") REFERENCES "public"."metrics"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_metric_stats_fk" FOREIGN KEY ("metric_stats_id") REFERENCES "public"."metric_stats"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_metrics_id_idx" ON "payload_locked_documents_rels" USING btree ("metrics_id");
  CREATE INDEX "payload_locked_documents_rels_metric_stats_id_idx" ON "payload_locked_documents_rels" USING btree ("metric_stats_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "metrics" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "metrics_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "metric_stats" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "metrics" CASCADE;
  DROP TABLE "metrics_rels" CASCADE;
  DROP TABLE "metric_stats" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_metrics_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_metric_stats_fk";
  
  DROP INDEX "payload_locked_documents_rels_metrics_id_idx";
  DROP INDEX "payload_locked_documents_rels_metric_stats_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "metrics_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "metric_stats_id";
  DROP TYPE "public"."enum_metrics_aggregation";
  DROP TYPE "public"."enum_metrics_default_view";
  DROP TYPE "public"."enum_metrics_source";
  DROP TYPE "public"."enum_metric_stats_granularity";`)
}
