import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_templates_components_impact" AS ENUM('operational', 'degraded_performance', 'partial_outage', 'major_outage');
  CREATE TYPE "public"."enum_templates_kind" AS ENUM('incident', 'incident-update', 'maintenance');
  CREATE TYPE "public"."enum_templates_status" AS ENUM('investigating', 'identified', 'monitoring', 'resolved');
  CREATE TYPE "public"."enum_templates_impact" AS ENUM('operational', 'degraded_performance', 'partial_outage', 'major_outage');
  CREATE TABLE "templates_components" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"component" varchar,
  	"impact" "enum_templates_components_impact" DEFAULT 'major_outage'
  );
  
  CREATE TABLE "templates" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"kind" "enum_templates_kind" DEFAULT 'incident' NOT NULL,
  	"title" varchar,
  	"body" varchar,
  	"status" "enum_templates_status",
  	"impact" "enum_templates_impact",
  	"duration" numeric,
  	"status_page_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "templates_id" integer;
  ALTER TABLE "templates_components" ADD CONSTRAINT "templates_components_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "templates" ADD CONSTRAINT "templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "templates" ADD CONSTRAINT "templates_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "templates_components_order_idx" ON "templates_components" USING btree ("_order");
  CREATE INDEX "templates_components_parent_id_idx" ON "templates_components" USING btree ("_parent_id");
  CREATE INDEX "templates_organization_idx" ON "templates" USING btree ("organization_id");
  CREATE INDEX "templates_status_page_idx" ON "templates" USING btree ("status_page_id");
  CREATE INDEX "templates_updated_at_idx" ON "templates" USING btree ("updated_at");
  CREATE INDEX "templates_created_at_idx" ON "templates" USING btree ("created_at");
  CREATE UNIQUE INDEX "organization_name_1_idx" ON "templates" USING btree ("organization_id","name");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_templates_fk" FOREIGN KEY ("templates_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_templates_id_idx" ON "payload_locked_documents_rels" USING btree ("templates_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "templates_components" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "templates" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "templates_components" CASCADE;
  DROP TABLE "templates" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_templates_fk";
  
  DROP INDEX "payload_locked_documents_rels_templates_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "templates_id";
  DROP TYPE "public"."enum_templates_components_impact";
  DROP TYPE "public"."enum_templates_kind";
  DROP TYPE "public"."enum_templates_status";
  DROP TYPE "public"."enum_templates_impact";`)
}
