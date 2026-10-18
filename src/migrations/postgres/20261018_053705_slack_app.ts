import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_monitor_incidents_timeline_via" ADD VALUE 'slack';
  ALTER TYPE "public"."enum_monitor_incidents_acknowledged_via" ADD VALUE 'slack';
  CREATE TABLE "slack_installations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"team_id" varchar NOT NULL,
  	"team_name" varchar,
  	"enterprise_id" varchar,
  	"app_id" varchar,
  	"bot_user_id" varchar,
  	"bot_token" varchar NOT NULL,
  	"installed_by_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "slack_installations_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "slack_user_links" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"installation_id" integer NOT NULL,
  	"team_id" varchar NOT NULL,
  	"slack_user_id" varchar NOT NULL,
  	"user_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "slack_installations_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "slack_user_links_id" integer;
  ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_installed_by_id_users_id_fk" FOREIGN KEY ("installed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "slack_installations_texts" ADD CONSTRAINT "slack_installations_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "slack_installations_organization_idx" ON "slack_installations" USING btree ("organization_id");
  CREATE UNIQUE INDEX "slack_installations_team_id_idx" ON "slack_installations" USING btree ("team_id");
  CREATE INDEX "slack_installations_installed_by_idx" ON "slack_installations" USING btree ("installed_by_id");
  CREATE INDEX "slack_installations_updated_at_idx" ON "slack_installations" USING btree ("updated_at");
  CREATE INDEX "slack_installations_created_at_idx" ON "slack_installations" USING btree ("created_at");
  CREATE INDEX "slack_installations_texts_order_parent" ON "slack_installations_texts" USING btree ("order","parent_id");
  CREATE INDEX "slack_user_links_organization_idx" ON "slack_user_links" USING btree ("organization_id");
  CREATE INDEX "slack_user_links_installation_idx" ON "slack_user_links" USING btree ("installation_id");
  CREATE INDEX "slack_user_links_user_idx" ON "slack_user_links" USING btree ("user_id");
  CREATE INDEX "slack_user_links_updated_at_idx" ON "slack_user_links" USING btree ("updated_at");
  CREATE INDEX "slack_user_links_created_at_idx" ON "slack_user_links" USING btree ("created_at");
  CREATE UNIQUE INDEX "teamId_slackUserId_idx" ON "slack_user_links" USING btree ("team_id","slack_user_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_slack_installations_fk" FOREIGN KEY ("slack_installations_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_slack_user_links_fk" FOREIGN KEY ("slack_user_links_id") REFERENCES "public"."slack_user_links"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_slack_installations_id_idx" ON "payload_locked_documents_rels" USING btree ("slack_installations_id");
  CREATE INDEX "payload_locked_documents_rels_slack_user_links_id_idx" ON "payload_locked_documents_rels" USING btree ("slack_user_links_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "slack_installations" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "slack_installations_texts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "slack_user_links" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "slack_installations" CASCADE;
  DROP TABLE "slack_installations_texts" CASCADE;
  DROP TABLE "slack_user_links" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_slack_installations_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_slack_user_links_fk";
  
  ALTER TABLE "monitor_incidents_timeline" ALTER COLUMN "via" SET DATA TYPE text;
  DROP TYPE "public"."enum_monitor_incidents_timeline_via";
  CREATE TYPE "public"."enum_monitor_incidents_timeline_via" AS ENUM('dashboard', 'api', 'link');
  ALTER TABLE "monitor_incidents_timeline" ALTER COLUMN "via" SET DATA TYPE "public"."enum_monitor_incidents_timeline_via" USING "via"::"public"."enum_monitor_incidents_timeline_via";
  ALTER TABLE "monitor_incidents" ALTER COLUMN "acknowledged_via" SET DATA TYPE text;
  DROP TYPE "public"."enum_monitor_incidents_acknowledged_via";
  CREATE TYPE "public"."enum_monitor_incidents_acknowledged_via" AS ENUM('dashboard', 'api', 'link');
  ALTER TABLE "monitor_incidents" ALTER COLUMN "acknowledged_via" SET DATA TYPE "public"."enum_monitor_incidents_acknowledged_via" USING "acknowledged_via"::"public"."enum_monitor_incidents_acknowledged_via";
  DROP INDEX "payload_locked_documents_rels_slack_installations_id_idx";
  DROP INDEX "payload_locked_documents_rels_slack_user_links_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "slack_installations_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "slack_user_links_id";`)
}
