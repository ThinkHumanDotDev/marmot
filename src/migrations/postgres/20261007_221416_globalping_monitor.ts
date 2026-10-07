import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_globalping_measurement" AS ENUM('ping', 'http', 'dns', 'traceroute');
  CREATE TYPE "public"."enum_monitors_globalping_protocol" AS ENUM('ICMP', 'TCP', 'UDP', 'HTTP', 'HTTPS', 'HTTP2');
  CREATE TYPE "public"."enum_monitors_globalping_ip_version" AS ENUM('4', '6');
  CREATE TYPE "public"."enum_monitors_globalping_success_rule" AS ENUM('all', 'any', 'atLeast');
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'globalping' BEFORE 'push';
  ALTER TABLE "monitors" ADD COLUMN "globalping_measurement" "enum_monitors_globalping_measurement" DEFAULT 'http';
  ALTER TABLE "monitors" ADD COLUMN "globalping_protocol" "enum_monitors_globalping_protocol";
  ALTER TABLE "monitors" ADD COLUMN "globalping_ip_version" "enum_monitors_globalping_ip_version";
  ALTER TABLE "monitors" ADD COLUMN "globalping_locations" varchar;
  ALTER TABLE "monitors" ADD COLUMN "globalping_probes" numeric DEFAULT 3;
  ALTER TABLE "monitors" ADD COLUMN "globalping_success_rule" "enum_monitors_globalping_success_rule" DEFAULT 'all';
  ALTER TABLE "monitors" ADD COLUMN "globalping_min_success" numeric;
  ALTER TABLE "monitors" ADD COLUMN "globalping_packets" numeric DEFAULT 3;
  ALTER TABLE "heartbeats" ADD COLUMN "probes" jsonb;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE text;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_monitors_type";
  CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'port', 'ping', 'dns', 'push', 'group', 'manual', 'docker', 'grpc-keyword', 'websocket-upgrade', 'mqtt', 'kafka-producer', 'rabbitmq', 'smtp', 'snmp', 'ntp', 'sftp', 'radius', 'tailscale-ping', 'real-browser', 'mysql', 'postgres', 'sqlserver', 'mongodb', 'redis', 'steam', 'gamedig');
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::"public"."enum_monitors_type";
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitors_type" USING "type"::"public"."enum_monitors_type";
  ALTER TABLE "monitors" DROP COLUMN "globalping_measurement";
  ALTER TABLE "monitors" DROP COLUMN "globalping_protocol";
  ALTER TABLE "monitors" DROP COLUMN "globalping_ip_version";
  ALTER TABLE "monitors" DROP COLUMN "globalping_locations";
  ALTER TABLE "monitors" DROP COLUMN "globalping_probes";
  ALTER TABLE "monitors" DROP COLUMN "globalping_success_rule";
  ALTER TABLE "monitors" DROP COLUMN "globalping_min_success";
  ALTER TABLE "monitors" DROP COLUMN "globalping_packets";
  ALTER TABLE "heartbeats" DROP COLUMN "probes";
  DROP TYPE "public"."enum_monitors_globalping_measurement";
  DROP TYPE "public"."enum_monitors_globalping_protocol";
  DROP TYPE "public"."enum_monitors_globalping_ip_version";
  DROP TYPE "public"."enum_monitors_globalping_success_rule";`)
}
