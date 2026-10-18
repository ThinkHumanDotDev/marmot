import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_host_metrics_granularity" AS ENUM('minute', 'hour', 'day');
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'host' BEFORE 'group';
  CREATE TABLE "host_metrics" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"monitor_id" integer NOT NULL,
  	"organization_id" integer NOT NULL,
  	"granularity" "enum_host_metrics_granularity" NOT NULL,
  	"timestamp" numeric NOT NULL,
  	"last_at" numeric NOT NULL,
  	"series" jsonb NOT NULL,
  	"latest" jsonb
  );
  
  ALTER TABLE "monitors" ADD COLUMN "host_thresholds" jsonb;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "host_metrics_id" integer;
  ALTER TABLE "host_metrics" ADD CONSTRAINT "host_metrics_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "host_metrics" ADD CONSTRAINT "host_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "host_metrics_monitor_idx" ON "host_metrics" USING btree ("monitor_id");
  CREATE INDEX "host_metrics_organization_idx" ON "host_metrics" USING btree ("organization_id");
  CREATE INDEX "host_metrics_granularity_idx" ON "host_metrics" USING btree ("granularity");
  CREATE INDEX "host_metrics_timestamp_idx" ON "host_metrics" USING btree ("timestamp");
  CREATE UNIQUE INDEX "monitor_granularity_timestamp_idx" ON "host_metrics" USING btree ("monitor_id","granularity","timestamp");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_host_metrics_fk" FOREIGN KEY ("host_metrics_id") REFERENCES "public"."host_metrics"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_host_metrics_id_idx" ON "payload_locked_documents_rels" USING btree ("host_metrics_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "host_metrics" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "host_metrics" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_host_metrics_fk";
  
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE text;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_monitors_type";
  CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'prometheus', 'http-suite', 'port', 'ping', 'dns', 'globalping', 'status-page', 'push', 'group', 'manual', 'docker', 'grpc-keyword', 'websocket-upgrade', 'mqtt', 'kafka-producer', 'rabbitmq', 'smtp', 'snmp', 'ntp', 'sftp', 'ssh', 'udp', 'tls', 'imap', 'pop3', 'radius', 'tailscale-ping', 'real-browser', 'mysql', 'postgres', 'sqlserver', 'mongodb', 'redis', 'steam', 'gamedig');
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::"public"."enum_monitors_type";
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitors_type" USING "type"::"public"."enum_monitors_type";
  DROP INDEX "payload_locked_documents_rels_host_metrics_id_idx";
  ALTER TABLE "monitors" DROP COLUMN "host_thresholds";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "host_metrics_id";
  DROP TYPE "public"."enum_host_metrics_granularity";`)
}
