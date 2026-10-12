import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_push_email_unmatched" AS ENUM('ignore', 'fail');
  ALTER TABLE "monitors" ADD COLUMN "push_email_failure_keyword" varchar;
  ALTER TABLE "monitors" ADD COLUMN "push_email_success_keyword" varchar;
  ALTER TABLE "monitors" ADD COLUMN "push_email_start_keyword" varchar;
  ALTER TABLE "monitors" ADD COLUMN "push_email_unmatched" "enum_monitors_push_email_unmatched" DEFAULT 'ignore';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" DROP COLUMN "push_email_failure_keyword";
  ALTER TABLE "monitors" DROP COLUMN "push_email_success_keyword";
  ALTER TABLE "monitors" DROP COLUMN "push_email_start_keyword";
  ALTER TABLE "monitors" DROP COLUMN "push_email_unmatched";
  DROP TYPE "public"."enum_monitors_push_email_unmatched";`)
}
