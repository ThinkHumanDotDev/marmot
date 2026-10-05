import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_theme" AS ENUM('system', 'light', 'dark');
  ALTER TABLE "users" ADD COLUMN "theme" "enum_users_theme" DEFAULT 'system';
  ALTER TABLE "users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false;
  ALTER TABLE "users" ADD COLUMN "two_factor_verified_at" timestamp(3) with time zone;
  ALTER TABLE "users" ADD COLUMN "two_factor_secret" varchar;
  ALTER TABLE "users" ADD COLUMN "two_factor_pending_secret" varchar;
  ALTER TABLE "users" ADD COLUMN "two_factor_backup_codes" jsonb;
  ALTER TABLE "users" ADD COLUMN "two_factor_last_used_step" numeric;
  ALTER TABLE "organizations" ADD COLUMN "permission_overrides" jsonb;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" DROP COLUMN "theme";
  ALTER TABLE "users" DROP COLUMN "two_factor_enabled";
  ALTER TABLE "users" DROP COLUMN "two_factor_verified_at";
  ALTER TABLE "users" DROP COLUMN "two_factor_secret";
  ALTER TABLE "users" DROP COLUMN "two_factor_pending_secret";
  ALTER TABLE "users" DROP COLUMN "two_factor_backup_codes";
  ALTER TABLE "users" DROP COLUMN "two_factor_last_used_step";
  ALTER TABLE "organizations" DROP COLUMN "permission_overrides";
  DROP TYPE "public"."enum_users_theme";`)
}
