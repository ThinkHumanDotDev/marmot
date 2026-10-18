import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_notification_sent_history_type" ADD VALUE 'issue';
  ALTER TABLE "notification_sent_history" ADD COLUMN "external_id" varchar;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "notification_sent_history" ALTER COLUMN "type" SET DATA TYPE text;
  DROP TYPE "public"."enum_notification_sent_history_type";
  CREATE TYPE "public"."enum_notification_sent_history_type" AS ENUM('certificate', 'domain', 'ct');
  ALTER TABLE "notification_sent_history" ALTER COLUMN "type" SET DATA TYPE "public"."enum_notification_sent_history_type" USING "type"::"public"."enum_notification_sent_history_type";
  ALTER TABLE "notification_sent_history" DROP COLUMN "external_id";`)
}
