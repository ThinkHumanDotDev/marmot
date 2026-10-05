import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_organizations_role" AS ENUM('owner', 'admin', 'member', 'viewer');
  CREATE TYPE "public"."enum_organizations_plan" AS ENUM('free', 'team', 'pro', 'enterprise');
  CREATE TYPE "public"."enum_organizations_settings_week_start" AS ENUM('monday', 'sunday');
  CREATE TYPE "public"."enum_invitations_role" AS ENUM('owner', 'admin', 'member', 'viewer');
  CREATE TYPE "public"."enum_invitations_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');
  CREATE TABLE "users_organizations" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"role" "enum_users_organizations_role" DEFAULT 'member' NOT NULL
  );
  
  CREATE TABLE "invitations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"email" varchar NOT NULL,
  	"role" "enum_invitations_role" DEFAULT 'member' NOT NULL,
  	"token" varchar,
  	"status" "enum_invitations_status" DEFAULT 'pending',
  	"expires_at" timestamp(3) with time zone,
  	"invited_by_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "users" ADD COLUMN "avatar_id" integer;
  ALTER TABLE "organizations" ADD COLUMN "slug" varchar NOT NULL;
  ALTER TABLE "organizations" ADD COLUMN "logo_id" integer;
  ALTER TABLE "organizations" ADD COLUMN "plan" "enum_organizations_plan" DEFAULT 'free';
  ALTER TABLE "organizations" ADD COLUMN "settings_timezone" varchar DEFAULT 'UTC';
  ALTER TABLE "organizations" ADD COLUMN "settings_week_start" "enum_organizations_settings_week_start" DEFAULT 'monday';
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "invitations_id" integer;
  ALTER TABLE "users_organizations" ADD CONSTRAINT "users_organizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "users_organizations" ADD CONSTRAINT "users_organizations_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "users_organizations_order_idx" ON "users_organizations" USING btree ("_order");
  CREATE INDEX "users_organizations_parent_id_idx" ON "users_organizations" USING btree ("_parent_id");
  CREATE INDEX "users_organizations_organization_idx" ON "users_organizations" USING btree ("organization_id");
  CREATE INDEX "invitations_organization_idx" ON "invitations" USING btree ("organization_id");
  CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");
  CREATE UNIQUE INDEX "invitations_token_idx" ON "invitations" USING btree ("token");
  CREATE INDEX "invitations_status_idx" ON "invitations" USING btree ("status");
  CREATE INDEX "invitations_invited_by_idx" ON "invitations" USING btree ("invited_by_id");
  CREATE INDEX "invitations_updated_at_idx" ON "invitations" USING btree ("updated_at");
  CREATE INDEX "invitations_created_at_idx" ON "invitations" USING btree ("created_at");
  ALTER TABLE "users" ADD CONSTRAINT "users_avatar_id_media_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "organizations" ADD CONSTRAINT "organizations_logo_id_media_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_invitations_fk" FOREIGN KEY ("invitations_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "users_avatar_idx" ON "users" USING btree ("avatar_id");
  CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");
  CREATE INDEX "organizations_logo_idx" ON "organizations" USING btree ("logo_id");
  CREATE INDEX "payload_locked_documents_rels_invitations_id_idx" ON "payload_locked_documents_rels" USING btree ("invitations_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users_organizations" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "invitations" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "users_organizations" CASCADE;
  DROP TABLE "invitations" CASCADE;
  ALTER TABLE "users" DROP CONSTRAINT "users_avatar_id_media_id_fk";
  
  ALTER TABLE "organizations" DROP CONSTRAINT "organizations_logo_id_media_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_invitations_fk";
  
  DROP INDEX "users_avatar_idx";
  DROP INDEX "organizations_slug_idx";
  DROP INDEX "organizations_logo_idx";
  DROP INDEX "payload_locked_documents_rels_invitations_id_idx";
  ALTER TABLE "users" DROP COLUMN "avatar_id";
  ALTER TABLE "organizations" DROP COLUMN "slug";
  ALTER TABLE "organizations" DROP COLUMN "logo_id";
  ALTER TABLE "organizations" DROP COLUMN "plan";
  ALTER TABLE "organizations" DROP COLUMN "settings_timezone";
  ALTER TABLE "organizations" DROP COLUMN "settings_week_start";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "invitations_id";
  DROP TYPE "public"."enum_users_organizations_role";
  DROP TYPE "public"."enum_organizations_plan";
  DROP TYPE "public"."enum_organizations_settings_week_start";
  DROP TYPE "public"."enum_invitations_role";
  DROP TYPE "public"."enum_invitations_status";`)
}
