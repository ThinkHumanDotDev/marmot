import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" ADD COLUMN "key" varchar;
  CREATE INDEX "organization_key_idx" ON "monitors" USING btree ("organization_id","key");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "organization_key_idx";
  ALTER TABLE "monitors" DROP COLUMN "key";`)
}
