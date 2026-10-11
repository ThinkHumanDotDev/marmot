import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_prometheus_down_operator" AS ENUM('>', '>=', '<', '<=', '==', '!=');
  CREATE TYPE "public"."enum_monitors_prometheus_degraded_operator" AS ENUM('>', '>=', '<', '<=', '==', '!=');
  CREATE TYPE "public"."enum_monitors_prometheus_aggregate" AS ENUM('worst', 'any', 'all');
  CREATE TYPE "public"."enum_monitors_prometheus_no_data_status" AS ENUM('up', 'down', 'pending');
  CREATE TYPE "public"."enum_monitors_prometheus_error_status" AS ENUM('up', 'down', 'pending');
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'prometheus' BEFORE 'port';
  ALTER TABLE "monitors" ADD COLUMN "prometheus_query" varchar;
  ALTER TABLE "monitors" ADD COLUMN "prometheus_down_operator" "enum_monitors_prometheus_down_operator" DEFAULT '>';
  ALTER TABLE "monitors" ADD COLUMN "prometheus_down_threshold" numeric;
  ALTER TABLE "monitors" ADD COLUMN "prometheus_degraded_operator" "enum_monitors_prometheus_degraded_operator";
  ALTER TABLE "monitors" ADD COLUMN "prometheus_degraded_threshold" numeric;
  ALTER TABLE "monitors" ADD COLUMN "prometheus_aggregate" "enum_monitors_prometheus_aggregate" DEFAULT 'worst';
  ALTER TABLE "monitors" ADD COLUMN "prometheus_no_data_status" "enum_monitors_prometheus_no_data_status" DEFAULT 'down';
  ALTER TABLE "monitors" ADD COLUMN "prometheus_error_status" "enum_monitors_prometheus_error_status" DEFAULT 'down';
  ALTER TABLE "heartbeats" ADD COLUMN "value" numeric;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE text;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_monitors_type";
  CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'port', 'ping', 'dns', 'globalping', 'push', 'group', 'manual', 'docker', 'grpc-keyword', 'websocket-upgrade', 'mqtt', 'kafka-producer', 'rabbitmq', 'smtp', 'snmp', 'ntp', 'sftp', 'radius', 'tailscale-ping', 'real-browser', 'mysql', 'postgres', 'sqlserver', 'mongodb', 'redis', 'steam', 'gamedig');
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::"public"."enum_monitors_type";
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitors_type" USING "type"::"public"."enum_monitors_type";
  ALTER TABLE "monitors" DROP COLUMN "prometheus_query";
  ALTER TABLE "monitors" DROP COLUMN "prometheus_down_operator";
  ALTER TABLE "monitors" DROP COLUMN "prometheus_down_threshold";
  ALTER TABLE "monitors" DROP COLUMN "prometheus_degraded_operator";
  ALTER TABLE "monitors" DROP COLUMN "prometheus_degraded_threshold";
  ALTER TABLE "monitors" DROP COLUMN "prometheus_aggregate";
  ALTER TABLE "monitors" DROP COLUMN "prometheus_no_data_status";
  ALTER TABLE "monitors" DROP COLUMN "prometheus_error_status";
  ALTER TABLE "heartbeats" DROP COLUMN "value";
  DROP TYPE "public"."enum_monitors_prometheus_down_operator";
  DROP TYPE "public"."enum_monitors_prometheus_degraded_operator";
  DROP TYPE "public"."enum_monitors_prometheus_aggregate";
  DROP TYPE "public"."enum_monitors_prometheus_no_data_status";
  DROP TYPE "public"."enum_monitors_prometheus_error_status";`)
}
