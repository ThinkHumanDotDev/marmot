import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_monitor_incidents_timeline_via" ADD VALUE 'phone';
  ALTER TYPE "public"."enum_monitor_incidents_acknowledged_via" ADD VALUE 'phone';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitor_incidents_timeline" ALTER COLUMN "via" SET DATA TYPE text;
  DROP TYPE "public"."enum_monitor_incidents_timeline_via";
  CREATE TYPE "public"."enum_monitor_incidents_timeline_via" AS ENUM('dashboard', 'api', 'link');
  ALTER TABLE "monitor_incidents_timeline" ALTER COLUMN "via" SET DATA TYPE "public"."enum_monitor_incidents_timeline_via" USING "via"::"public"."enum_monitor_incidents_timeline_via";
  ALTER TABLE "monitor_incidents" ALTER COLUMN "acknowledged_via" SET DATA TYPE text;
  DROP TYPE "public"."enum_monitor_incidents_acknowledged_via";
  CREATE TYPE "public"."enum_monitor_incidents_acknowledged_via" AS ENUM('dashboard', 'api', 'link');
  ALTER TABLE "monitor_incidents" ALTER COLUMN "acknowledged_via" SET DATA TYPE "public"."enum_monitor_incidents_acknowledged_via" USING "acknowledged_via"::"public"."enum_monitor_incidents_acknowledged_via";`)
}
