import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_locations_status" AS ENUM('unknown', 'online', 'offline');
  CREATE TABLE "locations_labels" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"value" varchar
  );
  
  CREATE TABLE "locations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"token_hash" varchar NOT NULL,
  	"token_prefix" varchar NOT NULL,
  	"token_rotated_at" timestamp(3) with time zone,
  	"status" "enum_locations_status" DEFAULT 'unknown' NOT NULL,
  	"status_changed_at" timestamp(3) with time zone,
  	"last_seen_at" timestamp(3) with time zone,
  	"agent_version" varchar,
  	"agent_hostname" varchar,
  	"agent_platform" varchar,
  	"created_by_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "monitors_rels" ADD COLUMN "locations_id" integer;
  ALTER TABLE "heartbeats" ADD COLUMN "location_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "locations_id" integer;
  ALTER TABLE "locations_labels" ADD CONSTRAINT "locations_labels_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "locations" ADD CONSTRAINT "locations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "locations_labels_order_idx" ON "locations_labels" USING btree ("_order");
  CREATE INDEX "locations_labels_parent_id_idx" ON "locations_labels" USING btree ("_parent_id");
  CREATE INDEX "locations_organization_idx" ON "locations" USING btree ("organization_id");
  CREATE INDEX "locations_slug_idx" ON "locations" USING btree ("slug");
  CREATE UNIQUE INDEX "locations_token_hash_idx" ON "locations" USING btree ("token_hash");
  CREATE INDEX "locations_status_idx" ON "locations" USING btree ("status");
  CREATE INDEX "locations_last_seen_at_idx" ON "locations" USING btree ("last_seen_at");
  CREATE INDEX "locations_created_by_idx" ON "locations" USING btree ("created_by_id");
  CREATE INDEX "locations_updated_at_idx" ON "locations" USING btree ("updated_at");
  CREATE INDEX "locations_created_at_idx" ON "locations" USING btree ("created_at");
  CREATE UNIQUE INDEX "organization_slug_idx" ON "locations" USING btree ("organization_id","slug");
  ALTER TABLE "monitors_rels" ADD CONSTRAINT "monitors_rels_locations_fk" FOREIGN KEY ("locations_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_locations_fk" FOREIGN KEY ("locations_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "monitors_rels_locations_id_idx" ON "monitors_rels" USING btree ("locations_id");
  CREATE INDEX "heartbeats_location_idx" ON "heartbeats" USING btree ("location_id");
  CREATE INDEX "payload_locked_documents_rels_locations_id_idx" ON "payload_locked_documents_rels" USING btree ("locations_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "locations_labels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "locations" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "locations_labels" CASCADE;
  DROP TABLE "locations" CASCADE;
  ALTER TABLE "monitors_rels" DROP CONSTRAINT "monitors_rels_locations_fk";
  
  ALTER TABLE "heartbeats" DROP CONSTRAINT "heartbeats_location_id_locations_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_locations_fk";
  
  DROP INDEX "monitors_rels_locations_id_idx";
  DROP INDEX "heartbeats_location_idx";
  DROP INDEX "payload_locked_documents_rels_locations_id_idx";
  ALTER TABLE "monitors_rels" DROP COLUMN "locations_id";
  ALTER TABLE "heartbeats" DROP COLUMN "location_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "locations_id";
  DROP TYPE "public"."enum_locations_status";`)
}
