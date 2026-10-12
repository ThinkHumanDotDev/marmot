import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_status_pages_access" ADD VALUE 'audience';
  CREATE TABLE "status_page_audiences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"status_page_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "status_page_audiences_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "status_page_subscribers_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"status_page_audiences_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "status_page_audiences_id" integer;
  ALTER TABLE "status_page_audiences" ADD CONSTRAINT "status_page_audiences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "status_page_audiences" ADD CONSTRAINT "status_page_audiences_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "status_page_audiences_texts" ADD CONSTRAINT "status_page_audiences_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."status_page_audiences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_page_subscribers_rels" ADD CONSTRAINT "status_page_subscribers_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."status_page_subscribers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_page_subscribers_rels" ADD CONSTRAINT "status_page_subscribers_rels_status_page_audiences_fk" FOREIGN KEY ("status_page_audiences_id") REFERENCES "public"."status_page_audiences"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "status_page_audiences_organization_idx" ON "status_page_audiences" USING btree ("organization_id");
  CREATE INDEX "status_page_audiences_status_page_idx" ON "status_page_audiences" USING btree ("status_page_id");
  CREATE INDEX "status_page_audiences_updated_at_idx" ON "status_page_audiences" USING btree ("updated_at");
  CREATE INDEX "status_page_audiences_created_at_idx" ON "status_page_audiences" USING btree ("created_at");
  CREATE UNIQUE INDEX "statusPage_name_idx" ON "status_page_audiences" USING btree ("status_page_id","name");
  CREATE INDEX "status_page_audiences_texts_order_parent" ON "status_page_audiences_texts" USING btree ("order","parent_id");
  CREATE INDEX "status_page_subscribers_rels_order_idx" ON "status_page_subscribers_rels" USING btree ("order");
  CREATE INDEX "status_page_subscribers_rels_parent_idx" ON "status_page_subscribers_rels" USING btree ("parent_id");
  CREATE INDEX "status_page_subscribers_rels_path_idx" ON "status_page_subscribers_rels" USING btree ("path");
  CREATE INDEX "status_page_subscribers_rels_status_page_audiences_id_idx" ON "status_page_subscribers_rels" USING btree ("status_page_audiences_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_status_page_audiences_fk" FOREIGN KEY ("status_page_audiences_id") REFERENCES "public"."status_page_audiences"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_status_page_audiences_id_idx" ON "payload_locked_documents_rels" USING btree ("status_page_audiences_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_page_audiences" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_page_audiences_texts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_page_subscribers_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "status_page_audiences" CASCADE;
  DROP TABLE "status_page_audiences_texts" CASCADE;
  DROP TABLE "status_page_subscribers_rels" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_status_page_audiences_fk";
  
  ALTER TABLE "status_pages" ALTER COLUMN "access" SET DATA TYPE text;
  ALTER TABLE "status_pages" ALTER COLUMN "access" SET DEFAULT 'public'::text;
  DROP TYPE "public"."enum_status_pages_access";
  CREATE TYPE "public"."enum_status_pages_access" AS ENUM('public', 'password', 'email-domain', 'ip-allowlist');
  ALTER TABLE "status_pages" ALTER COLUMN "access" SET DEFAULT 'public'::"public"."enum_status_pages_access";
  ALTER TABLE "status_pages" ALTER COLUMN "access" SET DATA TYPE "public"."enum_status_pages_access" USING "access"::"public"."enum_status_pages_access";
  DROP INDEX "payload_locked_documents_rels_status_page_audiences_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "status_page_audiences_id";`)
}
