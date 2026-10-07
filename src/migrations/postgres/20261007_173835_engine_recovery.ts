import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_reminder_backoff" AS ENUM('none', 'linear', 'exponential');
  ALTER TABLE "monitors" ADD COLUMN "success_threshold" numeric DEFAULT 1;
  ALTER TABLE "monitors" ADD COLUMN "reminder_backoff" "enum_monitors_reminder_backoff" DEFAULT 'none';
  ALTER TABLE "monitors" ADD COLUMN "max_reminders" numeric DEFAULT 0;
  ALTER TABLE "monitors" ADD COLUMN "status_recoveries" numeric DEFAULT 0;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" DROP COLUMN "success_threshold";
  ALTER TABLE "monitors" DROP COLUMN "reminder_backoff";
  ALTER TABLE "monitors" DROP COLUMN "max_reminders";
  ALTER TABLE "monitors" DROP COLUMN "status_recoveries";
  DROP TYPE "public"."enum_monitors_reminder_backoff";`)
}
