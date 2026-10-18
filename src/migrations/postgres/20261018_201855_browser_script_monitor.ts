import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_browser_artifacts" AS ENUM('failure', 'always');
  CREATE TYPE "public"."enum_check_artifacts_kind" AS ENUM('screenshot', 'trace');
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'browser-script' BEFORE 'mysql';
  CREATE TABLE "monitors_browser_variables" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"value" varchar
  );
  
  CREATE TABLE "monitors_browser_secrets" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"value" varchar
  );
  
  CREATE TABLE "check_artifacts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"heartbeat_id" integer,
  	"kind" "enum_check_artifacts_kind" NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric
  );
  
  ALTER TABLE "monitors" ADD COLUMN "browser_script" varchar;
  ALTER TABLE "monitors" ADD COLUMN "browser_artifacts" "enum_monitors_browser_artifacts" DEFAULT 'failure';
  ALTER TABLE "heartbeats" ADD COLUMN "browser" jsonb;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "check_artifacts_id" integer;
  ALTER TABLE "monitors_browser_variables" ADD CONSTRAINT "monitors_browser_variables_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "monitors_browser_secrets" ADD CONSTRAINT "monitors_browser_secrets_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "check_artifacts" ADD CONSTRAINT "check_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "check_artifacts" ADD CONSTRAINT "check_artifacts_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "check_artifacts" ADD CONSTRAINT "check_artifacts_heartbeat_id_heartbeats_id_fk" FOREIGN KEY ("heartbeat_id") REFERENCES "public"."heartbeats"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "monitors_browser_variables_order_idx" ON "monitors_browser_variables" USING btree ("_order");
  CREATE INDEX "monitors_browser_variables_parent_id_idx" ON "monitors_browser_variables" USING btree ("_parent_id");
  CREATE INDEX "monitors_browser_secrets_order_idx" ON "monitors_browser_secrets" USING btree ("_order");
  CREATE INDEX "monitors_browser_secrets_parent_id_idx" ON "monitors_browser_secrets" USING btree ("_parent_id");
  CREATE INDEX "check_artifacts_organization_idx" ON "check_artifacts" USING btree ("organization_id");
  CREATE INDEX "check_artifacts_monitor_idx" ON "check_artifacts" USING btree ("monitor_id");
  CREATE INDEX "check_artifacts_heartbeat_idx" ON "check_artifacts" USING btree ("heartbeat_id");
  CREATE INDEX "check_artifacts_updated_at_idx" ON "check_artifacts" USING btree ("updated_at");
  CREATE INDEX "check_artifacts_created_at_idx" ON "check_artifacts" USING btree ("created_at");
  CREATE UNIQUE INDEX "check_artifacts_filename_idx" ON "check_artifacts" USING btree ("filename");
  CREATE INDEX "monitor_createdAt_idx" ON "check_artifacts" USING btree ("monitor_id","created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_check_artifacts_fk" FOREIGN KEY ("check_artifacts_id") REFERENCES "public"."check_artifacts"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_check_artifacts_id_idx" ON "payload_locked_documents_rels" USING btree ("check_artifacts_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors_browser_variables" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "monitors_browser_secrets" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "check_artifacts" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "monitors_browser_variables" CASCADE;
  DROP TABLE "monitors_browser_secrets" CASCADE;
  DROP TABLE "check_artifacts" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_check_artifacts_fk";
  
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE text;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_monitors_type";
  CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'prometheus', 'http-suite', 'port', 'ping', 'dns', 'globalping', 'status-page', 'push', 'group', 'manual', 'docker', 'grpc-keyword', 'websocket-upgrade', 'mqtt', 'kafka-producer', 'rabbitmq', 'smtp', 'snmp', 'ntp', 'sftp', 'ssh', 'udp', 'tls', 'imap', 'pop3', 'radius', 'tailscale-ping', 'real-browser', 'mysql', 'postgres', 'sqlserver', 'mongodb', 'redis', 'steam', 'gamedig');
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::"public"."enum_monitors_type";
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitors_type" USING "type"::"public"."enum_monitors_type";
  DROP INDEX "payload_locked_documents_rels_check_artifacts_id_idx";
  ALTER TABLE "monitors" DROP COLUMN "browser_script";
  ALTER TABLE "monitors" DROP COLUMN "browser_artifacts";
  ALTER TABLE "heartbeats" DROP COLUMN "browser";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "check_artifacts_id";
  DROP TYPE "public"."enum_monitors_browser_artifacts";
  DROP TYPE "public"."enum_check_artifacts_kind";`)
}
