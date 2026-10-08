import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "stat_minutely" ADD COLUMN "latency_histogram" jsonb;
  ALTER TABLE "stat_hourly" ADD COLUMN "latency_histogram" jsonb;
  ALTER TABLE "stat_daily" ADD COLUMN "latency_histogram" jsonb;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "stat_minutely" DROP COLUMN "latency_histogram";
  ALTER TABLE "stat_hourly" DROP COLUMN "latency_histogram";
  ALTER TABLE "stat_daily" DROP COLUMN "latency_histogram";`)
}
