import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_sso_connections_type" AS ENUM('oidc', 'saml');
  CREATE TYPE "public"."enum_sso_connections_default_role" AS ENUM('admin', 'member', 'viewer');
  CREATE TABLE "sso_connections" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"type" "enum_sso_connections_type" DEFAULT 'oidc' NOT NULL,
  	"enabled" boolean DEFAULT true,
  	"issuer_url" varchar,
  	"client_id" varchar,
  	"client_secret" varchar,
  	"scopes" varchar DEFAULT 'openid email profile',
  	"idp_entry_point" varchar,
  	"idp_entity_id" varchar,
  	"idp_cert" varchar,
  	"want_assertions_signed" boolean DEFAULT true,
  	"allow_idp_initiated" boolean DEFAULT false,
  	"auto_provision" boolean DEFAULT true,
  	"default_role" "enum_sso_connections_default_role" DEFAULT 'member',
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "sso_domains" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"domain" varchar NOT NULL,
  	"verification_token" varchar NOT NULL,
  	"verified_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "sso_connections_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "sso_domains_id" integer;
  ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "sso_connections_organization_idx" ON "sso_connections" USING btree ("organization_id");
  CREATE UNIQUE INDEX "sso_connections_slug_idx" ON "sso_connections" USING btree ("slug");
  CREATE INDEX "sso_connections_enabled_idx" ON "sso_connections" USING btree ("enabled");
  CREATE INDEX "sso_connections_updated_at_idx" ON "sso_connections" USING btree ("updated_at");
  CREATE INDEX "sso_connections_created_at_idx" ON "sso_connections" USING btree ("created_at");
  CREATE INDEX "organization_enabled_idx" ON "sso_connections" USING btree ("organization_id","enabled");
  CREATE INDEX "sso_domains_organization_idx" ON "sso_domains" USING btree ("organization_id");
  CREATE UNIQUE INDEX "sso_domains_domain_idx" ON "sso_domains" USING btree ("domain");
  CREATE INDEX "sso_domains_updated_at_idx" ON "sso_domains" USING btree ("updated_at");
  CREATE INDEX "sso_domains_created_at_idx" ON "sso_domains" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sso_connections_fk" FOREIGN KEY ("sso_connections_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sso_domains_fk" FOREIGN KEY ("sso_domains_id") REFERENCES "public"."sso_domains"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_sso_connections_id_idx" ON "payload_locked_documents_rels" USING btree ("sso_connections_id");
  CREATE INDEX "payload_locked_documents_rels_sso_domains_id_idx" ON "payload_locked_documents_rels" USING btree ("sso_domains_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "sso_connections" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "sso_domains" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "sso_connections" CASCADE;
  DROP TABLE "sso_domains" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_sso_connections_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_sso_domains_fk";
  
  DROP INDEX "payload_locked_documents_rels_sso_connections_id_idx";
  DROP INDEX "payload_locked_documents_rels_sso_domains_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "sso_connections_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "sso_domains_id";
  DROP TYPE "public"."enum_sso_connections_type";
  DROP TYPE "public"."enum_sso_connections_default_role";`)
}
