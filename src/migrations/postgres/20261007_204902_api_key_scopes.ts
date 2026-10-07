import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_api_keys_scope" AS ENUM('read', 'write');
  ALTER TABLE "api_keys" ADD COLUMN "scope" "enum_api_keys_scope" DEFAULT 'read' NOT NULL;
  CREATE INDEX "api_keys_scope_idx" ON "api_keys" USING btree ("scope");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "api_keys_scope_idx";
  ALTER TABLE "api_keys" DROP COLUMN "scope";
  DROP TYPE "public"."enum_api_keys_scope";`)
}
