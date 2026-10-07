import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_status_page_viewers_status" AS ENUM('active', 'revoked');
  ALTER TYPE "public"."enum_status_pages_access" ADD VALUE 'email-domain';
  ALTER TYPE "public"."enum_status_pages_access" ADD VALUE 'ip-allowlist';
  CREATE TABLE "status_pages_allowed_email_domains" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"domain" varchar
  );
  
  CREATE TABLE "status_pages_allowed_ip_ranges" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"cidr" varchar,
  	"label" varchar
  );
  
  CREATE TABLE "status_page_viewers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"page_id" integer NOT NULL,
  	"email" varchar NOT NULL,
  	"status" "enum_status_page_viewers_status" DEFAULT 'active' NOT NULL,
  	"last_seen_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "status_page_viewers_id" integer;
  ALTER TABLE "status_pages_allowed_email_domains" ADD CONSTRAINT "status_pages_allowed_email_domains_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_pages_allowed_ip_ranges" ADD CONSTRAINT "status_pages_allowed_ip_ranges_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_page_viewers" ADD CONSTRAINT "status_page_viewers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "status_page_viewers" ADD CONSTRAINT "status_page_viewers_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."status_pages"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "status_pages_allowed_email_domains_order_idx" ON "status_pages_allowed_email_domains" USING btree ("_order");
  CREATE INDEX "status_pages_allowed_email_domains_parent_id_idx" ON "status_pages_allowed_email_domains" USING btree ("_parent_id");
  CREATE INDEX "status_pages_allowed_ip_ranges_order_idx" ON "status_pages_allowed_ip_ranges" USING btree ("_order");
  CREATE INDEX "status_pages_allowed_ip_ranges_parent_id_idx" ON "status_pages_allowed_ip_ranges" USING btree ("_parent_id");
  CREATE INDEX "status_page_viewers_organization_idx" ON "status_page_viewers" USING btree ("organization_id");
  CREATE INDEX "status_page_viewers_page_idx" ON "status_page_viewers" USING btree ("page_id");
  CREATE INDEX "status_page_viewers_updated_at_idx" ON "status_page_viewers" USING btree ("updated_at");
  CREATE INDEX "status_page_viewers_created_at_idx" ON "status_page_viewers" USING btree ("created_at");
  CREATE UNIQUE INDEX "page_email_idx" ON "status_page_viewers" USING btree ("page_id","email");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_status_page_viewers_fk" FOREIGN KEY ("status_page_viewers_id") REFERENCES "public"."status_page_viewers"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_status_page_viewers_id_idx" ON "payload_locked_documents_rels" USING btree ("status_page_viewers_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_pages_allowed_email_domains" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_pages_allowed_ip_ranges" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_page_viewers" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "status_pages_allowed_email_domains" CASCADE;
  DROP TABLE "status_pages_allowed_ip_ranges" CASCADE;
  DROP TABLE "status_page_viewers" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_status_page_viewers_fk";
  
  ALTER TABLE "status_pages" ALTER COLUMN "access" SET DATA TYPE text;
  ALTER TABLE "status_pages" ALTER COLUMN "access" SET DEFAULT 'public'::text;
  DROP TYPE "public"."enum_status_pages_access";
  CREATE TYPE "public"."enum_status_pages_access" AS ENUM('public', 'password');
  ALTER TABLE "status_pages" ALTER COLUMN "access" SET DEFAULT 'public'::"public"."enum_status_pages_access";
  ALTER TABLE "status_pages" ALTER COLUMN "access" SET DATA TYPE "public"."enum_status_pages_access" USING "access"::"public"."enum_status_pages_access";
  DROP INDEX "payload_locked_documents_rels_status_page_viewers_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "status_page_viewers_id";
  DROP TYPE "public"."enum_status_page_viewers_status";`)
}
