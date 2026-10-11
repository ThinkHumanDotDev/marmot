import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_users_auth_provider" ADD VALUE 'magic-link';
  ALTER TABLE "instance_settings" ADD COLUMN "magic_link_enabled" boolean;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" ALTER COLUMN "auth_provider" SET DATA TYPE text;
  ALTER TABLE "users" ALTER COLUMN "auth_provider" SET DEFAULT 'local'::text;
  DROP TYPE "public"."enum_users_auth_provider";
  CREATE TYPE "public"."enum_users_auth_provider" AS ENUM('local', 'oidc', 'oauth', 'saml');
  ALTER TABLE "users" ALTER COLUMN "auth_provider" SET DEFAULT 'local'::"public"."enum_users_auth_provider";
  ALTER TABLE "users" ALTER COLUMN "auth_provider" SET DATA TYPE "public"."enum_users_auth_provider" USING "auth_provider"::"public"."enum_users_auth_provider";
  ALTER TABLE "instance_settings" DROP COLUMN "magic_link_enabled";`)
}
