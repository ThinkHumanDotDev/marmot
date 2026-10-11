import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_status_page_provider" AS ENUM('auto', 'atlassian', 'instatus', 'betterstack', 'incidentio', 'feed');
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'status-page' BEFORE 'push';
  ALTER TABLE "monitors" ADD COLUMN "status_page_provider" "enum_monitors_status_page_provider" DEFAULT 'auto';
  ALTER TABLE "monitors" ADD COLUMN "status_page_components" jsonb;
  ALTER TABLE "monitors" ADD COLUMN "status_cache_seconds" numeric;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE text;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_monitors_type";
  CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'port', 'ping', 'dns', 'globalping', 'push', 'group', 'manual', 'docker', 'grpc-keyword', 'websocket-upgrade', 'mqtt', 'kafka-producer', 'rabbitmq', 'smtp', 'snmp', 'ntp', 'sftp', 'radius', 'tailscale-ping', 'real-browser', 'mysql', 'postgres', 'sqlserver', 'mongodb', 'redis', 'steam', 'gamedig');
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::"public"."enum_monitors_type";
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitors_type" USING "type"::"public"."enum_monitors_type";
  ALTER TABLE "monitors" DROP COLUMN "status_page_provider";
  ALTER TABLE "monitors" DROP COLUMN "status_page_components";
  ALTER TABLE "monitors" DROP COLUMN "status_cache_seconds";
  DROP TYPE "public"."enum_monitors_status_page_provider";`)
}
