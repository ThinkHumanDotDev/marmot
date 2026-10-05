import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'port', 'ping', 'dns', 'push', 'group', 'manual');
  CREATE TYPE "public"."enum_monitors_method" AS ENUM('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS');
  CREATE TYPE "public"."enum_monitors_http_body_encoding" AS ENUM('json', 'form', 'xml');
  CREATE TYPE "public"."enum_monitors_json_path_operator" AS ENUM('==', '!=', '<', '>', '<=', '>=', 'contains');
  CREATE TYPE "public"."enum_monitors_auth_method" AS ENUM('none', 'basic', 'bearer', 'oauth2-cc', 'ntlm', 'mtls');
  CREATE TYPE "public"."enum_monitors_oauth_auth_method" AS ENUM('client_secret_basic', 'client_secret_post');
  CREATE TYPE "public"."enum_monitors_dns_resolve_type" AS ENUM('A', 'AAAA', 'CAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT');
  CREATE TYPE "public"."enum_monitors_manual_status" AS ENUM('up', 'down', 'pending');
  CREATE TYPE "public"."enum_monitors_status_last_status" AS ENUM('up', 'down', 'pending', 'maintenance');
  CREATE TYPE "public"."enum_heartbeats_status" AS ENUM('up', 'down', 'pending', 'maintenance');
  CREATE TABLE "organizations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "monitors" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer,
  	"name" varchar NOT NULL,
  	"type" "enum_monitors_type" DEFAULT 'http' NOT NULL,
  	"active" boolean DEFAULT true,
  	"parent_id" integer,
  	"description" varchar,
  	"weight" numeric DEFAULT 2000,
  	"url" varchar,
  	"hostname" varchar,
  	"port" numeric,
  	"interval" numeric DEFAULT 60 NOT NULL,
  	"retry_interval" numeric DEFAULT 60 NOT NULL,
  	"max_retries" numeric DEFAULT 0 NOT NULL,
  	"resend_interval" numeric DEFAULT 0 NOT NULL,
  	"timeout" numeric DEFAULT 48 NOT NULL,
  	"upside_down" boolean DEFAULT false,
  	"method" "enum_monitors_method" DEFAULT 'GET',
  	"http_body_encoding" "enum_monitors_http_body_encoding" DEFAULT 'json',
  	"max_redirects" numeric DEFAULT 10,
  	"body" varchar,
  	"headers" varchar,
  	"ignore_tls" boolean DEFAULT false,
  	"expiry_notification" boolean DEFAULT false,
  	"keyword" varchar,
  	"invert_keyword" boolean DEFAULT false,
  	"json_path" varchar,
  	"json_path_operator" "enum_monitors_json_path_operator" DEFAULT '==',
  	"expected_value" varchar,
  	"auth_method" "enum_monitors_auth_method" DEFAULT 'none',
  	"basic_auth_user" varchar,
  	"basic_auth_pass" varchar,
  	"auth_domain" varchar,
  	"auth_workstation" varchar,
  	"bearer_token" varchar,
  	"oauth_token_url" varchar,
  	"oauth_client_id" varchar,
  	"oauth_client_secret" varchar,
  	"oauth_scopes" varchar,
  	"oauth_auth_method" "enum_monitors_oauth_auth_method" DEFAULT 'client_secret_basic',
  	"tls_cert" varchar,
  	"tls_key" varchar,
  	"tls_ca" varchar,
  	"dns_resolve_server" varchar DEFAULT '1.1.1.1',
  	"dns_resolve_type" "enum_monitors_dns_resolve_type" DEFAULT 'A',
  	"push_token" varchar,
  	"manual_status" "enum_monitors_manual_status",
  	"status_last_status" "enum_monitors_status_last_status",
  	"status_last_check_at" timestamp(3) with time zone,
  	"status_last_ping" numeric,
  	"status_last_msg" varchar,
  	"status_retries" numeric DEFAULT 0,
  	"status_down_count" numeric DEFAULT 0,
  	"status_last_push_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "monitors_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "heartbeats" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"organization_id" integer,
  	"status" "enum_heartbeats_status" NOT NULL,
  	"msg" varchar,
  	"ping" numeric,
  	"duration" numeric,
  	"important" boolean DEFAULT false,
  	"retries" numeric DEFAULT 0,
  	"down_count" numeric DEFAULT 0,
  	"time" timestamp(3) with time zone NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "organizations_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "monitors_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "heartbeats_id" integer;
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_parent_id_monitors_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitors_texts" ADD CONSTRAINT "monitors_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "organizations_updated_at_idx" ON "organizations" USING btree ("updated_at");
  CREATE INDEX "organizations_created_at_idx" ON "organizations" USING btree ("created_at");
  CREATE INDEX "monitors_organization_idx" ON "monitors" USING btree ("organization_id");
  CREATE INDEX "monitors_active_idx" ON "monitors" USING btree ("active");
  CREATE INDEX "monitors_parent_idx" ON "monitors" USING btree ("parent_id");
  CREATE INDEX "monitors_push_token_idx" ON "monitors" USING btree ("push_token");
  CREATE INDEX "monitors_updated_at_idx" ON "monitors" USING btree ("updated_at");
  CREATE INDEX "monitors_created_at_idx" ON "monitors" USING btree ("created_at");
  CREATE INDEX "organization_active_idx" ON "monitors" USING btree ("organization_id","active");
  CREATE INDEX "monitors_texts_order_parent" ON "monitors_texts" USING btree ("order","parent_id");
  CREATE INDEX "heartbeats_monitor_idx" ON "heartbeats" USING btree ("monitor_id");
  CREATE INDEX "heartbeats_organization_idx" ON "heartbeats" USING btree ("organization_id");
  CREATE INDEX "heartbeats_important_idx" ON "heartbeats" USING btree ("important");
  CREATE INDEX "heartbeats_time_idx" ON "heartbeats" USING btree ("time");
  CREATE INDEX "monitor_time_idx" ON "heartbeats" USING btree ("monitor_id","time");
  CREATE INDEX "monitor_important_time_idx" ON "heartbeats" USING btree ("monitor_id","important","time");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_organizations_fk" FOREIGN KEY ("organizations_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_monitors_fk" FOREIGN KEY ("monitors_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_heartbeats_fk" FOREIGN KEY ("heartbeats_id") REFERENCES "public"."heartbeats"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_organizations_id_idx" ON "payload_locked_documents_rels" USING btree ("organizations_id");
  CREATE INDEX "payload_locked_documents_rels_monitors_id_idx" ON "payload_locked_documents_rels" USING btree ("monitors_id");
  CREATE INDEX "payload_locked_documents_rels_heartbeats_id_idx" ON "payload_locked_documents_rels" USING btree ("heartbeats_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "organizations" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "monitors" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "monitors_texts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "heartbeats" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "organizations" CASCADE;
  DROP TABLE "monitors" CASCADE;
  DROP TABLE "monitors_texts" CASCADE;
  DROP TABLE "heartbeats" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_organizations_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_monitors_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_heartbeats_fk";
  
  DROP INDEX "payload_locked_documents_rels_organizations_id_idx";
  DROP INDEX "payload_locked_documents_rels_monitors_id_idx";
  DROP INDEX "payload_locked_documents_rels_heartbeats_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "organizations_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "monitors_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "heartbeats_id";
  DROP TYPE "public"."enum_monitors_type";
  DROP TYPE "public"."enum_monitors_method";
  DROP TYPE "public"."enum_monitors_http_body_encoding";
  DROP TYPE "public"."enum_monitors_json_path_operator";
  DROP TYPE "public"."enum_monitors_auth_method";
  DROP TYPE "public"."enum_monitors_oauth_auth_method";
  DROP TYPE "public"."enum_monitors_dns_resolve_type";
  DROP TYPE "public"."enum_monitors_manual_status";
  DROP TYPE "public"."enum_monitors_status_last_status";
  DROP TYPE "public"."enum_heartbeats_status";`)
}
