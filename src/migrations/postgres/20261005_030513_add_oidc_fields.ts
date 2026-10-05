import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_auth_provider" AS ENUM('local', 'oidc');
  ALTER TABLE "users" ADD COLUMN "auth_provider" "enum_users_auth_provider" DEFAULT 'local';
  ALTER TABLE "users" ADD COLUMN "oidc_issuer" varchar;
  ALTER TABLE "users" ADD COLUMN "oidc_subject" varchar;
  CREATE UNIQUE INDEX "users_oidc_subject_idx" ON "users" USING btree ("oidc_subject");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "users_oidc_subject_idx";
  ALTER TABLE "users" DROP COLUMN "auth_provider";
  ALTER TABLE "users" DROP COLUMN "oidc_issuer";
  ALTER TABLE "users" DROP COLUMN "oidc_subject";
  DROP TYPE "public"."enum_users_auth_provider";`)
}
