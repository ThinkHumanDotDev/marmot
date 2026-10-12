import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_notification_sent_history_type" ADD VALUE 'ct';
  DROP INDEX "type_monitor_days_idx";
  ALTER TABLE "monitors" ADD COLUMN "ct_alerts" boolean DEFAULT false;
  ALTER TABLE "monitors" ADD COLUMN "ct_include_subdomains" boolean DEFAULT false;
  ALTER TABLE "monitors" ADD COLUMN "ct_state" jsonb;
  ALTER TABLE "notification_sent_history" ADD COLUMN "fingerprint" varchar DEFAULT '';
  CREATE UNIQUE INDEX "type_monitor_days_fingerprint_idx" ON "notification_sent_history" USING btree ("type","monitor_id","days","fingerprint");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "notification_sent_history" ALTER COLUMN "type" SET DATA TYPE text;
  DROP TYPE "public"."enum_notification_sent_history_type";
  CREATE TYPE "public"."enum_notification_sent_history_type" AS ENUM('certificate', 'domain');
  ALTER TABLE "notification_sent_history" ALTER COLUMN "type" SET DATA TYPE "public"."enum_notification_sent_history_type" USING "type"::"public"."enum_notification_sent_history_type";
  DROP INDEX "type_monitor_days_fingerprint_idx";
  CREATE UNIQUE INDEX "type_monitor_days_idx" ON "notification_sent_history" USING btree ("type","monitor_id","days");
  ALTER TABLE "monitors" DROP COLUMN "ct_alerts";
  ALTER TABLE "monitors" DROP COLUMN "ct_include_subdomains";
  ALTER TABLE "monitors" DROP COLUMN "ct_state";
  ALTER TABLE "notification_sent_history" DROP COLUMN "fingerprint";`)
}
