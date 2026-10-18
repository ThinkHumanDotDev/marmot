import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'http-suite' BEFORE 'port';
  ALTER TABLE "monitors" ADD COLUMN "http_suite" jsonb;
  ALTER TABLE "heartbeats" ADD COLUMN "steps" jsonb;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE text;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_monitors_type";
  CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'prometheus', 'port', 'ping', 'dns', 'globalping', 'status-page', 'push', 'group', 'manual', 'docker', 'grpc-keyword', 'websocket-upgrade', 'mqtt', 'kafka-producer', 'rabbitmq', 'smtp', 'snmp', 'ntp', 'sftp', 'ssh', 'udp', 'tls', 'imap', 'pop3', 'radius', 'tailscale-ping', 'real-browser', 'mysql', 'postgres', 'sqlserver', 'mongodb', 'redis', 'steam', 'gamedig');
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::"public"."enum_monitors_type";
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitors_type" USING "type"::"public"."enum_monitors_type";
  ALTER TABLE "monitors" DROP COLUMN "http_suite";
  ALTER TABLE "heartbeats" DROP COLUMN "steps";`)
}
