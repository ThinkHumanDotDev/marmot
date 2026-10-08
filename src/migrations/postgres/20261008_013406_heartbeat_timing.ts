import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "heartbeats" ADD COLUMN "timing_dns" numeric;
  ALTER TABLE "heartbeats" ADD COLUMN "timing_connect" numeric;
  ALTER TABLE "heartbeats" ADD COLUMN "timing_tls" numeric;
  ALTER TABLE "heartbeats" ADD COLUMN "timing_ttfb" numeric;
  ALTER TABLE "heartbeats" ADD COLUMN "timing_transfer" numeric;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "heartbeats" DROP COLUMN "timing_dns";
  ALTER TABLE "heartbeats" DROP COLUMN "timing_connect";
  ALTER TABLE "heartbeats" DROP COLUMN "timing_tls";
  ALTER TABLE "heartbeats" DROP COLUMN "timing_ttfb";
  ALTER TABLE "heartbeats" DROP COLUMN "timing_transfer";`)
}
