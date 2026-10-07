import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_webhook_endpoints_disabled_reason" AS ENUM('failures');
  CREATE TYPE "public"."enum_webhook_endpoints_last_delivery_state" AS ENUM('succeeded', 'failed');
  CREATE TYPE "public"."enum_webhook_deliveries_trigger" AS ENUM('event', 'redelivery', 'test');
  CREATE TYPE "public"."enum_webhook_deliveries_state" AS ENUM('pending', 'retrying', 'succeeded', 'failed', 'cancelled');
  CREATE TABLE "webhook_endpoints" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"url" varchar NOT NULL,
  	"description" varchar,
  	"events" jsonb NOT NULL,
  	"active" boolean DEFAULT true,
  	"secret" varchar,
  	"previous_secret" varchar,
  	"previous_secret_expires_at" timestamp(3) with time zone,
  	"consecutive_failures" numeric DEFAULT 0,
  	"disabled_reason" "enum_webhook_endpoints_disabled_reason",
  	"disabled_at" timestamp(3) with time zone,
  	"last_delivery_at" timestamp(3) with time zone,
  	"last_delivery_state" "enum_webhook_endpoints_last_delivery_state",
  	"created_by_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "webhook_deliveries" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"endpoint_id" integer NOT NULL,
  	"event_id" varchar NOT NULL,
  	"event_type" varchar NOT NULL,
  	"trigger" "enum_webhook_deliveries_trigger" DEFAULT 'event' NOT NULL,
  	"state" "enum_webhook_deliveries_state" DEFAULT 'pending' NOT NULL,
  	"attempts" numeric DEFAULT 0,
  	"body" jsonb NOT NULL,
  	"request_headers" jsonb,
  	"response_status" numeric,
  	"response_headers" jsonb,
  	"response_body" varchar,
  	"duration_ms" numeric,
  	"error" varchar,
  	"delivered_at" timestamp(3) with time zone,
  	"redelivery_of_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "webhook_endpoints_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "webhook_deliveries_id" integer;
  ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_redelivery_of_id_webhook_deliveries_id_fk" FOREIGN KEY ("redelivery_of_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "webhook_endpoints_organization_idx" ON "webhook_endpoints" USING btree ("organization_id");
  CREATE INDEX "webhook_endpoints_active_idx" ON "webhook_endpoints" USING btree ("active");
  CREATE INDEX "webhook_endpoints_created_by_idx" ON "webhook_endpoints" USING btree ("created_by_id");
  CREATE INDEX "webhook_endpoints_updated_at_idx" ON "webhook_endpoints" USING btree ("updated_at");
  CREATE INDEX "webhook_endpoints_created_at_idx" ON "webhook_endpoints" USING btree ("created_at");
  CREATE INDEX "organization_active_3_idx" ON "webhook_endpoints" USING btree ("organization_id","active");
  CREATE INDEX "webhook_deliveries_organization_idx" ON "webhook_deliveries" USING btree ("organization_id");
  CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("endpoint_id");
  CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries" USING btree ("event_id");
  CREATE INDEX "webhook_deliveries_event_type_idx" ON "webhook_deliveries" USING btree ("event_type");
  CREATE INDEX "webhook_deliveries_state_idx" ON "webhook_deliveries" USING btree ("state");
  CREATE INDEX "webhook_deliveries_redelivery_of_idx" ON "webhook_deliveries" USING btree ("redelivery_of_id");
  CREATE INDEX "webhook_deliveries_updated_at_idx" ON "webhook_deliveries" USING btree ("updated_at");
  CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING btree ("created_at");
  CREATE INDEX "endpoint_createdAt_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_webhook_endpoints_fk" FOREIGN KEY ("webhook_endpoints_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_webhook_deliveries_fk" FOREIGN KEY ("webhook_deliveries_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_webhook_endpoints_id_idx" ON "payload_locked_documents_rels" USING btree ("webhook_endpoints_id");
  CREATE INDEX "payload_locked_documents_rels_webhook_deliveries_id_idx" ON "payload_locked_documents_rels" USING btree ("webhook_deliveries_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "webhook_endpoints" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "webhook_deliveries" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "webhook_endpoints" CASCADE;
  DROP TABLE "webhook_deliveries" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_webhook_endpoints_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_webhook_deliveries_fk";
  
  DROP INDEX "payload_locked_documents_rels_webhook_endpoints_id_idx";
  DROP INDEX "payload_locked_documents_rels_webhook_deliveries_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "webhook_endpoints_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "webhook_deliveries_id";
  DROP TYPE "public"."enum_webhook_endpoints_disabled_reason";
  DROP TYPE "public"."enum_webhook_endpoints_last_delivery_state";
  DROP TYPE "public"."enum_webhook_deliveries_trigger";
  DROP TYPE "public"."enum_webhook_deliveries_state";`)
}
