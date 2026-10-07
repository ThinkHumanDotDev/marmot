import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_status_pages_access" AS ENUM('public', 'password');
  ALTER TABLE "status_pages" ADD COLUMN "access" "enum_status_pages_access" DEFAULT 'public';
  ALTER TABLE "status_pages" ADD COLUMN "password_hash" varchar;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_pages" DROP COLUMN "access";
  ALTER TABLE "status_pages" DROP COLUMN "password_hash";
  DROP TYPE "public"."enum_status_pages_access";`)
}
