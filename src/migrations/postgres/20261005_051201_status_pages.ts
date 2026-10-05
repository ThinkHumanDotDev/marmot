import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_status_pages_theme" AS ENUM('auto', 'light', 'dark');
  CREATE TYPE "public"."enum_incidents_style" AS ENUM('info', 'warning', 'danger', 'primary');
  CREATE TABLE "status_pages_domains" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"hostname" varchar NOT NULL
  );
  
  CREATE TABLE "status_pages_groups_monitors" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"send_url" boolean DEFAULT false,
  	"custom_url" varchar
  );
  
  CREATE TABLE "status_pages_groups" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL
  );
  
  CREATE TABLE "status_pages" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"title" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"description" varchar,
  	"logo_id" integer,
  	"theme" "enum_status_pages_theme" DEFAULT 'auto',
  	"published" boolean DEFAULT false,
  	"search_engine_index" boolean DEFAULT false,
  	"show_tags" boolean DEFAULT false,
  	"show_certificate_expiry" boolean DEFAULT false,
  	"show_powered_by" boolean DEFAULT true,
  	"auto_refresh_interval" numeric DEFAULT 300,
  	"footer_text" varchar,
  	"custom_c_s_s" varchar,
  	"google_analytics_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "incidents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"status_page_id" integer NOT NULL,
  	"title" varchar NOT NULL,
  	"content" varchar,
  	"style" "enum_incidents_style" DEFAULT 'info',
  	"pinned" boolean DEFAULT true,
  	"active" boolean DEFAULT true,
  	"resolved_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "status_pages_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "incidents_id" integer;
  ALTER TABLE "status_pages_domains" ADD CONSTRAINT "status_pages_domains_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_pages_groups_monitors" ADD CONSTRAINT "status_pages_groups_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "status_pages_groups_monitors" ADD CONSTRAINT "status_pages_groups_monitors_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."status_pages_groups"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_pages_groups" ADD CONSTRAINT "status_pages_groups_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_logo_id_media_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "incidents" ADD CONSTRAINT "incidents_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "status_pages_domains_order_idx" ON "status_pages_domains" USING btree ("_order");
  CREATE INDEX "status_pages_domains_parent_id_idx" ON "status_pages_domains" USING btree ("_parent_id");
  CREATE INDEX "status_pages_domains_hostname_idx" ON "status_pages_domains" USING btree ("hostname");
  CREATE INDEX "status_pages_groups_monitors_order_idx" ON "status_pages_groups_monitors" USING btree ("_order");
  CREATE INDEX "status_pages_groups_monitors_parent_id_idx" ON "status_pages_groups_monitors" USING btree ("_parent_id");
  CREATE INDEX "status_pages_groups_monitors_monitor_idx" ON "status_pages_groups_monitors" USING btree ("monitor_id");
  CREATE INDEX "status_pages_groups_order_idx" ON "status_pages_groups" USING btree ("_order");
  CREATE INDEX "status_pages_groups_parent_id_idx" ON "status_pages_groups" USING btree ("_parent_id");
  CREATE INDEX "status_pages_organization_idx" ON "status_pages" USING btree ("organization_id");
  CREATE UNIQUE INDEX "status_pages_slug_idx" ON "status_pages" USING btree ("slug");
  CREATE INDEX "status_pages_logo_idx" ON "status_pages" USING btree ("logo_id");
  CREATE INDEX "status_pages_published_idx" ON "status_pages" USING btree ("published");
  CREATE INDEX "status_pages_updated_at_idx" ON "status_pages" USING btree ("updated_at");
  CREATE INDEX "status_pages_created_at_idx" ON "status_pages" USING btree ("created_at");
  CREATE INDEX "organization_published_idx" ON "status_pages" USING btree ("organization_id","published");
  CREATE INDEX "incidents_organization_idx" ON "incidents" USING btree ("organization_id");
  CREATE INDEX "incidents_status_page_idx" ON "incidents" USING btree ("status_page_id");
  CREATE INDEX "incidents_active_idx" ON "incidents" USING btree ("active");
  CREATE INDEX "incidents_updated_at_idx" ON "incidents" USING btree ("updated_at");
  CREATE INDEX "incidents_created_at_idx" ON "incidents" USING btree ("created_at");
  CREATE INDEX "statusPage_active_pinned_idx" ON "incidents" USING btree ("status_page_id","active","pinned");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_status_pages_fk" FOREIGN KEY ("status_pages_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_incidents_fk" FOREIGN KEY ("incidents_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_status_pages_id_idx" ON "payload_locked_documents_rels" USING btree ("status_pages_id");
  CREATE INDEX "payload_locked_documents_rels_incidents_id_idx" ON "payload_locked_documents_rels" USING btree ("incidents_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_pages_domains" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_pages_groups_monitors" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_pages_groups" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_pages" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "incidents" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "status_pages_domains" CASCADE;
  DROP TABLE "status_pages_groups_monitors" CASCADE;
  DROP TABLE "status_pages_groups" CASCADE;
  DROP TABLE "status_pages" CASCADE;
  DROP TABLE "incidents" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_status_pages_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_incidents_fk";
  
  DROP INDEX "payload_locked_documents_rels_status_pages_id_idx";
  DROP INDEX "payload_locked_documents_rels_incidents_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "status_pages_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "incidents_id";
  DROP TYPE "public"."enum_status_pages_theme";
  DROP TYPE "public"."enum_incidents_style";`)
}
