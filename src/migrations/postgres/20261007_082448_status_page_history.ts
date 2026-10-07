import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_pages" ADD COLUMN "past_incidents_days" numeric DEFAULT 7;
  ALTER TABLE "incidents" ADD COLUMN "public_id" varchar;
  ALTER TABLE "maintenance_occurrences" ADD COLUMN "public_id" varchar;
  CREATE INDEX "incidents_public_id_idx" ON "incidents" USING btree ("public_id");
  CREATE INDEX "maintenance_occurrences_public_id_idx" ON "maintenance_occurrences" USING btree ("public_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "incidents_public_id_idx";
  DROP INDEX "maintenance_occurrences_public_id_idx";
  ALTER TABLE "status_pages" DROP COLUMN "past_incidents_days";
  ALTER TABLE "incidents" DROP COLUMN "public_id";
  ALTER TABLE "maintenance_occurrences" DROP COLUMN "public_id";`)
}
