import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "heartbeats" ADD COLUMN "status_code" numeric;
  ALTER TABLE "heartbeats" ADD COLUMN "response_headers" jsonb;
  ALTER TABLE "heartbeats" ADD COLUMN "response_headers_truncated" boolean;
  ALTER TABLE "heartbeats" ADD COLUMN "response_body" varchar;
  ALTER TABLE "heartbeats" ADD COLUMN "response_body_truncated" boolean;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "heartbeats" DROP COLUMN "status_code";
  ALTER TABLE "heartbeats" DROP COLUMN "response_headers";
  ALTER TABLE "heartbeats" DROP COLUMN "response_headers_truncated";
  ALTER TABLE "heartbeats" DROP COLUMN "response_body";
  ALTER TABLE "heartbeats" DROP COLUMN "response_body_truncated";`)
}
