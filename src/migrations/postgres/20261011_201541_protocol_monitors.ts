import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_udp_payload_encoding" AS ENUM('text', 'hex');
  CREATE TYPE "public"."enum_monitors_udp_response_match" AS ENUM('none', 'any', 'keyword', 'regex');
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'ssh' BEFORE 'radius';
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'udp' BEFORE 'radius';
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'tls' BEFORE 'radius';
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'imap' BEFORE 'radius';
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'pop3' BEFORE 'radius';
  ALTER TABLE "monitors" ADD COLUMN "mail_username" varchar;
  ALTER TABLE "monitors" ADD COLUMN "mail_password" varchar;
  ALTER TABLE "monitors" ADD COLUMN "udp_payload" varchar;
  ALTER TABLE "monitors" ADD COLUMN "udp_payload_encoding" "enum_monitors_udp_payload_encoding" DEFAULT 'text';
  ALTER TABLE "monitors" ADD COLUMN "udp_response_match" "enum_monitors_udp_response_match" DEFAULT 'none';
  ALTER TABLE "monitors" ADD COLUMN "udp_response_pattern" varchar;
  ALTER TABLE "monitors" ADD COLUMN "tls_servername" varchar;
  ALTER TABLE "monitors" ADD COLUMN "tls_alpn" varchar;
  ALTER TABLE "monitors" ADD COLUMN "ssh_command" varchar;
  ALTER TABLE "monitors" ADD COLUMN "ssh_expected_exit_code" numeric DEFAULT 0;
  ALTER TABLE "monitors" ADD COLUMN "ssh_expected_output" varchar;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE text;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_monitors_type";
  CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'port', 'ping', 'dns', 'globalping', 'status-page', 'push', 'group', 'manual', 'docker', 'grpc-keyword', 'websocket-upgrade', 'mqtt', 'kafka-producer', 'rabbitmq', 'smtp', 'snmp', 'ntp', 'sftp', 'radius', 'tailscale-ping', 'real-browser', 'mysql', 'postgres', 'sqlserver', 'mongodb', 'redis', 'steam', 'gamedig');
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::"public"."enum_monitors_type";
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitors_type" USING "type"::"public"."enum_monitors_type";
  ALTER TABLE "monitors" DROP COLUMN "mail_username";
  ALTER TABLE "monitors" DROP COLUMN "mail_password";
  ALTER TABLE "monitors" DROP COLUMN "udp_payload";
  ALTER TABLE "monitors" DROP COLUMN "udp_payload_encoding";
  ALTER TABLE "monitors" DROP COLUMN "udp_response_match";
  ALTER TABLE "monitors" DROP COLUMN "udp_response_pattern";
  ALTER TABLE "monitors" DROP COLUMN "tls_servername";
  ALTER TABLE "monitors" DROP COLUMN "tls_alpn";
  ALTER TABLE "monitors" DROP COLUMN "ssh_command";
  ALTER TABLE "monitors" DROP COLUMN "ssh_expected_exit_code";
  ALTER TABLE "monitors" DROP COLUMN "ssh_expected_output";
  DROP TYPE "public"."enum_monitors_udp_payload_encoding";
  DROP TYPE "public"."enum_monitors_udp_response_match";`)
}
