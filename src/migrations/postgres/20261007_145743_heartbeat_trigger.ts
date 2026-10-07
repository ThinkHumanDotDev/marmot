import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_heartbeats_trigger" AS ENUM('manual');
  ALTER TABLE "heartbeats" ADD COLUMN "trigger" "enum_heartbeats_trigger";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "heartbeats" DROP COLUMN "trigger";
  DROP TYPE "public"."enum_heartbeats_trigger";`)
}
