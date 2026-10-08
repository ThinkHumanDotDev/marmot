import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT true;
  ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp(3) with time zone;
  ALTER TABLE "instance_settings" ADD COLUMN "require_email_verification" boolean;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" DROP COLUMN "email_verified";
  ALTER TABLE "users" DROP COLUMN "email_verified_at";
  ALTER TABLE "instance_settings" DROP COLUMN "require_email_verification";`)
}
