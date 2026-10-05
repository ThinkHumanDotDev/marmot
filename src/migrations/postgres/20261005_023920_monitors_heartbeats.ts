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
  
  ALTER TABLE "monitors" ADD COLUMN "organization_id" integer;
  ALTER TABLE "monitors" ADD COLUMN "type" "enum_monitors_type" DEFAULT 'http' NOT NULL;
  ALTER TABLE "monitors" ADD COLUMN "active" boolean DEFAULT true;
  ALTER TABLE "monitors" ADD COLUMN "parent_id" integer;
  ALTER TABLE "monitors" ADD COLUMN "description" varchar;
  ALTER TABLE "monitors" ADD COLUMN "weight" numeric DEFAULT 2000;
  ALTER TABLE "monitors" ADD COLUMN "url" varchar;
  ALTER TABLE "monitors" ADD COLUMN "hostname" varchar;
  ALTER TABLE "monitors" ADD COLUMN "port" numeric;
  ALTER TABLE "monitors" ADD COLUMN "interval" numeric DEFAULT 60 NOT NULL;
  ALTER TABLE "monitors" ADD COLUMN "retry_interval" numeric DEFAULT 60 NOT NULL;
  ALTER TABLE "monitors" ADD COLUMN "max_retries" numeric DEFAULT 0 NOT NULL;
  ALTER TABLE "monitors" ADD COLUMN "resend_interval" numeric DEFAULT 0 NOT NULL;
  ALTER TABLE "monitors" ADD COLUMN "timeout" numeric DEFAULT 48 NOT NULL;
  ALTER TABLE "monitors" ADD COLUMN "upside_down" boolean DEFAULT false;
  ALTER TABLE "monitors" ADD COLUMN "method" "enum_monitors_method" DEFAULT 'GET';
  ALTER TABLE "monitors" ADD COLUMN "http_body_encoding" "enum_monitors_http_body_encoding" DEFAULT 'json';
  ALTER TABLE "monitors" ADD COLUMN "max_redirects" numeric DEFAULT 10;
  ALTER TABLE "monitors" ADD COLUMN "body" varchar;
  ALTER TABLE "monitors" ADD COLUMN "headers" varchar;
  ALTER TABLE "monitors" ADD COLUMN "ignore_tls" boolean DEFAULT false;
  ALTER TABLE "monitors" ADD COLUMN "expiry_notification" boolean DEFAULT false;
  ALTER TABLE "monitors" ADD COLUMN "keyword" varchar;
  ALTER TABLE "monitors" ADD COLUMN "invert_keyword" boolean DEFAULT false;
  ALTER TABLE "monitors" ADD COLUMN "json_path" varchar;
  ALTER TABLE "monitors" ADD COLUMN "json_path_operator" "enum_monitors_json_path_operator" DEFAULT '==';
  ALTER TABLE "monitors" ADD COLUMN "expected_value" varchar;
  ALTER TABLE "monitors" ADD COLUMN "auth_method" "enum_monitors_auth_method" DEFAULT 'none';
  ALTER TABLE "monitors" ADD COLUMN "basic_auth_user" varchar;
  ALTER TABLE "monitors" ADD COLUMN "basic_auth_pass" varchar;
  ALTER TABLE "monitors" ADD COLUMN "auth_domain" varchar;
  ALTER TABLE "monitors" ADD COLUMN "auth_workstation" varchar;
  ALTER TABLE "monitors" ADD COLUMN "bearer_token" varchar;
  ALTER TABLE "monitors" ADD COLUMN "oauth_token_url" varchar;
  ALTER TABLE "monitors" ADD COLUMN "oauth_client_id" varchar;
  ALTER TABLE "monitors" ADD COLUMN "oauth_client_secret" varchar;
  ALTER TABLE "monitors" ADD COLUMN "oauth_scopes" varchar;
  ALTER TABLE "monitors" ADD COLUMN "oauth_auth_method" "enum_monitors_oauth_auth_method" DEFAULT 'client_secret_basic';
  ALTER TABLE "monitors" ADD COLUMN "tls_cert" varchar;
  ALTER TABLE "monitors" ADD COLUMN "tls_key" varchar;
  ALTER TABLE "monitors" ADD COLUMN "tls_ca" varchar;
  ALTER TABLE "monitors" ADD COLUMN "dns_resolve_server" varchar DEFAULT '1.1.1.1';
  ALTER TABLE "monitors" ADD COLUMN "dns_resolve_type" "enum_monitors_dns_resolve_type" DEFAULT 'A';
  ALTER TABLE "monitors" ADD COLUMN "push_token" varchar;
  ALTER TABLE "monitors" ADD COLUMN "manual_status" "enum_monitors_manual_status";
  ALTER TABLE "monitors" ADD COLUMN "status_last_status" "enum_monitors_status_last_status";
  ALTER TABLE "monitors" ADD COLUMN "status_last_check_at" timestamp(3) with time zone;
  ALTER TABLE "monitors" ADD COLUMN "status_last_ping" numeric;
  ALTER TABLE "monitors" ADD COLUMN "status_last_msg" varchar;
  ALTER TABLE "monitors" ADD COLUMN "status_retries" numeric DEFAULT 0;
  ALTER TABLE "monitors" ADD COLUMN "status_down_count" numeric DEFAULT 0;
  ALTER TABLE "monitors" ADD COLUMN "status_last_push_at" timestamp(3) with time zone;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "heartbeats_id" integer;
  ALTER TABLE "monitors_texts" ADD CONSTRAINT "monitors_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "monitors_texts_order_parent" ON "monitors_texts" USING btree ("order","parent_id");
  CREATE INDEX "heartbeats_monitor_idx" ON "heartbeats" USING btree ("monitor_id");
  CREATE INDEX "heartbeats_organization_idx" ON "heartbeats" USING btree ("organization_id");
  CREATE INDEX "heartbeats_important_idx" ON "heartbeats" USING btree ("important");
  CREATE INDEX "heartbeats_time_idx" ON "heartbeats" USING btree ("time");
  CREATE INDEX "monitor_time_idx" ON "heartbeats" USING btree ("monitor_id","time");
  CREATE INDEX "monitor_important_time_idx" ON "heartbeats" USING btree ("monitor_id","important","time");
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_parent_id_monitors_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_heartbeats_fk" FOREIGN KEY ("heartbeats_id") REFERENCES "public"."heartbeats"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "monitors_organization_idx" ON "monitors" USING btree ("organization_id");
  CREATE INDEX "monitors_active_idx" ON "monitors" USING btree ("active");
  CREATE INDEX "monitors_parent_idx" ON "monitors" USING btree ("parent_id");
  CREATE INDEX "monitors_push_token_idx" ON "monitors" USING btree ("push_token");
  CREATE INDEX "organization_active_idx" ON "monitors" USING btree ("organization_id","active");
  CREATE INDEX "payload_locked_documents_rels_heartbeats_id_idx" ON "payload_locked_documents_rels" USING btree ("heartbeats_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors_texts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "heartbeats" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "monitors_texts" CASCADE;
  DROP TABLE "heartbeats" CASCADE;
  ALTER TABLE "monitors" DROP CONSTRAINT "monitors_organization_id_organizations_id_fk";
  
  ALTER TABLE "monitors" DROP CONSTRAINT "monitors_parent_id_monitors_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_heartbeats_fk";
  
  DROP INDEX "monitors_organization_idx";
  DROP INDEX "monitors_active_idx";
  DROP INDEX "monitors_parent_idx";
  DROP INDEX "monitors_push_token_idx";
  DROP INDEX "organization_active_idx";
  DROP INDEX "payload_locked_documents_rels_heartbeats_id_idx";
  ALTER TABLE "monitors" DROP COLUMN "organization_id";
  ALTER TABLE "monitors" DROP COLUMN "type";
  ALTER TABLE "monitors" DROP COLUMN "active";
  ALTER TABLE "monitors" DROP COLUMN "parent_id";
  ALTER TABLE "monitors" DROP COLUMN "description";
  ALTER TABLE "monitors" DROP COLUMN "weight";
  ALTER TABLE "monitors" DROP COLUMN "url";
  ALTER TABLE "monitors" DROP COLUMN "hostname";
  ALTER TABLE "monitors" DROP COLUMN "port";
  ALTER TABLE "monitors" DROP COLUMN "interval";
  ALTER TABLE "monitors" DROP COLUMN "retry_interval";
  ALTER TABLE "monitors" DROP COLUMN "max_retries";
  ALTER TABLE "monitors" DROP COLUMN "resend_interval";
  ALTER TABLE "monitors" DROP COLUMN "timeout";
  ALTER TABLE "monitors" DROP COLUMN "upside_down";
  ALTER TABLE "monitors" DROP COLUMN "method";
  ALTER TABLE "monitors" DROP COLUMN "http_body_encoding";
  ALTER TABLE "monitors" DROP COLUMN "max_redirects";
  ALTER TABLE "monitors" DROP COLUMN "body";
  ALTER TABLE "monitors" DROP COLUMN "headers";
  ALTER TABLE "monitors" DROP COLUMN "ignore_tls";
  ALTER TABLE "monitors" DROP COLUMN "expiry_notification";
  ALTER TABLE "monitors" DROP COLUMN "keyword";
  ALTER TABLE "monitors" DROP COLUMN "invert_keyword";
  ALTER TABLE "monitors" DROP COLUMN "json_path";
  ALTER TABLE "monitors" DROP COLUMN "json_path_operator";
  ALTER TABLE "monitors" DROP COLUMN "expected_value";
  ALTER TABLE "monitors" DROP COLUMN "auth_method";
  ALTER TABLE "monitors" DROP COLUMN "basic_auth_user";
  ALTER TABLE "monitors" DROP COLUMN "basic_auth_pass";
  ALTER TABLE "monitors" DROP COLUMN "auth_domain";
  ALTER TABLE "monitors" DROP COLUMN "auth_workstation";
  ALTER TABLE "monitors" DROP COLUMN "bearer_token";
  ALTER TABLE "monitors" DROP COLUMN "oauth_token_url";
  ALTER TABLE "monitors" DROP COLUMN "oauth_client_id";
  ALTER TABLE "monitors" DROP COLUMN "oauth_client_secret";
  ALTER TABLE "monitors" DROP COLUMN "oauth_scopes";
  ALTER TABLE "monitors" DROP COLUMN "oauth_auth_method";
  ALTER TABLE "monitors" DROP COLUMN "tls_cert";
  ALTER TABLE "monitors" DROP COLUMN "tls_key";
  ALTER TABLE "monitors" DROP COLUMN "tls_ca";
  ALTER TABLE "monitors" DROP COLUMN "dns_resolve_server";
  ALTER TABLE "monitors" DROP COLUMN "dns_resolve_type";
  ALTER TABLE "monitors" DROP COLUMN "push_token";
  ALTER TABLE "monitors" DROP COLUMN "manual_status";
  ALTER TABLE "monitors" DROP COLUMN "status_last_status";
  ALTER TABLE "monitors" DROP COLUMN "status_last_check_at";
  ALTER TABLE "monitors" DROP COLUMN "status_last_ping";
  ALTER TABLE "monitors" DROP COLUMN "status_last_msg";
  ALTER TABLE "monitors" DROP COLUMN "status_retries";
  ALTER TABLE "monitors" DROP COLUMN "status_down_count";
  ALTER TABLE "monitors" DROP COLUMN "status_last_push_at";
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
