import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_pagespeed_categories" AS ENUM('performance', 'accessibility', 'best-practices', 'seo');
  CREATE TYPE "public"."enum_monitors_pagespeed_backend" AS ENUM('psi', 'lighthouse');
  CREATE TYPE "public"."enum_monitors_pagespeed_strategy" AS ENUM('mobile', 'desktop');
  CREATE TYPE "public"."enum_monitors_pagespeed_fail_status" AS ENUM('degraded', 'down');
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'pagespeed' BEFORE 'mysql';
  CREATE TABLE "monitors_pagespeed_categories" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_monitors_pagespeed_categories",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  ALTER TABLE "monitors" ADD COLUMN "pagespeed_backend" "enum_monitors_pagespeed_backend" DEFAULT 'psi';
  ALTER TABLE "monitors" ADD COLUMN "pagespeed_strategy" "enum_monitors_pagespeed_strategy" DEFAULT 'mobile';
  ALTER TABLE "monitors" ADD COLUMN "pagespeed_fail_status" "enum_monitors_pagespeed_fail_status" DEFAULT 'degraded';
  ALTER TABLE "monitors" ADD COLUMN "pagespeed_min_performance" numeric;
  ALTER TABLE "monitors" ADD COLUMN "pagespeed_min_accessibility" numeric;
  ALTER TABLE "monitors" ADD COLUMN "pagespeed_min_best_practices" numeric;
  ALTER TABLE "monitors" ADD COLUMN "pagespeed_min_seo" numeric;
  ALTER TABLE "heartbeats" ADD COLUMN "pagespeed" jsonb;
  ALTER TABLE "instance_settings" ADD COLUMN "pagespeed_api_key" varchar;
  ALTER TABLE "monitors_pagespeed_categories" ADD CONSTRAINT "monitors_pagespeed_categories_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "monitors_pagespeed_categories_order_idx" ON "monitors_pagespeed_categories" USING btree ("order");
  CREATE INDEX "monitors_pagespeed_categories_parent_idx" ON "monitors_pagespeed_categories" USING btree ("parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "monitors_pagespeed_categories" CASCADE;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE text;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_monitors_type";
  CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'prometheus', 'port', 'ping', 'dns', 'globalping', 'status-page', 'push', 'group', 'manual', 'docker', 'grpc-keyword', 'websocket-upgrade', 'mqtt', 'kafka-producer', 'rabbitmq', 'smtp', 'snmp', 'ntp', 'sftp', 'ssh', 'udp', 'tls', 'imap', 'pop3', 'radius', 'tailscale-ping', 'real-browser', 'mysql', 'postgres', 'sqlserver', 'mongodb', 'redis', 'steam', 'gamedig');
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::"public"."enum_monitors_type";
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitors_type" USING "type"::"public"."enum_monitors_type";
  ALTER TABLE "monitors" DROP COLUMN "pagespeed_backend";
  ALTER TABLE "monitors" DROP COLUMN "pagespeed_strategy";
  ALTER TABLE "monitors" DROP COLUMN "pagespeed_fail_status";
  ALTER TABLE "monitors" DROP COLUMN "pagespeed_min_performance";
  ALTER TABLE "monitors" DROP COLUMN "pagespeed_min_accessibility";
  ALTER TABLE "monitors" DROP COLUMN "pagespeed_min_best_practices";
  ALTER TABLE "monitors" DROP COLUMN "pagespeed_min_seo";
  ALTER TABLE "heartbeats" DROP COLUMN "pagespeed";
  ALTER TABLE "instance_settings" DROP COLUMN "pagespeed_api_key";
  DROP TYPE "public"."enum_monitors_pagespeed_categories";
  DROP TYPE "public"."enum_monitors_pagespeed_backend";
  DROP TYPE "public"."enum_monitors_pagespeed_strategy";
  DROP TYPE "public"."enum_monitors_pagespeed_fail_status";`)
}
