import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_status_settled_status" AS ENUM('up', 'down', 'pending', 'maintenance', 'degraded');
  ALTER TYPE "public"."enum_monitors_status_last_status" ADD VALUE 'degraded';
  ALTER TYPE "public"."enum_heartbeats_status" ADD VALUE 'degraded';
  ALTER TABLE "monitors" ADD COLUMN "degraded_after" numeric;
  ALTER TABLE "monitors" ADD COLUMN "status_settled_status" "enum_monitors_status_settled_status";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" ALTER COLUMN "status_last_status" SET DATA TYPE text;
  DROP TYPE "public"."enum_monitors_status_last_status";
  CREATE TYPE "public"."enum_monitors_status_last_status" AS ENUM('up', 'down', 'pending', 'maintenance');
  ALTER TABLE "monitors" ALTER COLUMN "status_last_status" SET DATA TYPE "public"."enum_monitors_status_last_status" USING "status_last_status"::"public"."enum_monitors_status_last_status";
  ALTER TABLE "heartbeats" ALTER COLUMN "status" SET DATA TYPE text;
  DROP TYPE "public"."enum_heartbeats_status";
  CREATE TYPE "public"."enum_heartbeats_status" AS ENUM('up', 'down', 'pending', 'maintenance');
  ALTER TABLE "heartbeats" ALTER COLUMN "status" SET DATA TYPE "public"."enum_heartbeats_status" USING "status"::"public"."enum_heartbeats_status";
  ALTER TABLE "monitors" DROP COLUMN "degraded_after";
  ALTER TABLE "monitors" DROP COLUMN "status_settled_status";
  DROP TYPE "public"."enum_monitors_status_settled_status";`)
}
