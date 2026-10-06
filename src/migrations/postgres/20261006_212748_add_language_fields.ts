import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_language" AS ENUM('en');
  CREATE TYPE "public"."enum_organizations_settings_language" AS ENUM('en');
  CREATE TYPE "public"."enum_status_pages_language" AS ENUM('auto', 'en');
  ALTER TABLE "users" ADD COLUMN "language" "enum_users_language" DEFAULT 'en';
  ALTER TABLE "organizations" ADD COLUMN "settings_language" "enum_organizations_settings_language" DEFAULT 'en';
  ALTER TABLE "status_pages" ADD COLUMN "language" "enum_status_pages_language" DEFAULT 'en';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" DROP COLUMN "language";
  ALTER TABLE "organizations" DROP COLUMN "settings_language";
  ALTER TABLE "status_pages" DROP COLUMN "language";
  DROP TYPE "public"."enum_users_language";
  DROP TYPE "public"."enum_organizations_settings_language";
  DROP TYPE "public"."enum_status_pages_language";`)
}
