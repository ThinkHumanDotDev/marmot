import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "otel_collectors" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"endpoint" varchar NOT NULL,
  	"headers" varchar,
  	"header_names" jsonb,
  	"active" boolean DEFAULT true,
  	"default" boolean DEFAULT false,
  	"last_export_at" timestamp(3) with time zone,
  	"last_error" varchar,
  	"created_by_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "monitors" ADD COLUMN "otlp_export" boolean DEFAULT true;
  ALTER TABLE "monitors" ADD COLUMN "otlp_collector_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "otel_collectors_id" integer;
  ALTER TABLE "otel_collectors" ADD CONSTRAINT "otel_collectors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "otel_collectors" ADD CONSTRAINT "otel_collectors_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "otel_collectors_organization_idx" ON "otel_collectors" USING btree ("organization_id");
  CREATE INDEX "otel_collectors_default_idx" ON "otel_collectors" USING btree ("default");
  CREATE INDEX "otel_collectors_created_by_idx" ON "otel_collectors" USING btree ("created_by_id");
  CREATE INDEX "otel_collectors_updated_at_idx" ON "otel_collectors" USING btree ("updated_at");
  CREATE INDEX "otel_collectors_created_at_idx" ON "otel_collectors" USING btree ("created_at");
  CREATE INDEX "organization_default_1_idx" ON "otel_collectors" USING btree ("organization_id","default");
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_otlp_collector_id_otel_collectors_id_fk" FOREIGN KEY ("otlp_collector_id") REFERENCES "public"."otel_collectors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_otel_collectors_fk" FOREIGN KEY ("otel_collectors_id") REFERENCES "public"."otel_collectors"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "monitors_otlp_collector_idx" ON "monitors" USING btree ("otlp_collector_id");
  CREATE INDEX "payload_locked_documents_rels_otel_collectors_id_idx" ON "payload_locked_documents_rels" USING btree ("otel_collectors_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "otel_collectors" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "otel_collectors" CASCADE;
  ALTER TABLE "monitors" DROP CONSTRAINT "monitors_otlp_collector_id_otel_collectors_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_otel_collectors_fk";
  
  DROP INDEX "monitors_otlp_collector_idx";
  DROP INDEX "payload_locked_documents_rels_otel_collectors_id_idx";
  ALTER TABLE "monitors" DROP COLUMN "otlp_export";
  ALTER TABLE "monitors" DROP COLUMN "otlp_collector_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "otel_collectors_id";`)
}
