import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_aggregation" AS ENUM('worst', 'quorum', 'weighted');
  CREATE TYPE "public"."enum_monitors_aggregation_quorum_unit" AS ENUM('count', 'percent');
  CREATE TYPE "public"."enum_monitors_aggregation_latency" AS ENUM('none', 'avg', 'max', 'min');
  ALTER TABLE "monitors" ADD COLUMN "aggregation" "enum_monitors_aggregation" DEFAULT 'worst';
  ALTER TABLE "monitors" ADD COLUMN "aggregation_quorum" numeric;
  ALTER TABLE "monitors" ADD COLUMN "aggregation_quorum_unit" "enum_monitors_aggregation_quorum_unit" DEFAULT 'count';
  ALTER TABLE "monitors" ADD COLUMN "aggregation_latency" "enum_monitors_aggregation_latency" DEFAULT 'none';
  ALTER TABLE "monitors" ADD COLUMN "group_weight" numeric DEFAULT 1;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors" DROP COLUMN "aggregation";
  ALTER TABLE "monitors" DROP COLUMN "aggregation_quorum";
  ALTER TABLE "monitors" DROP COLUMN "aggregation_quorum_unit";
  ALTER TABLE "monitors" DROP COLUMN "aggregation_latency";
  ALTER TABLE "monitors" DROP COLUMN "group_weight";
  DROP TYPE "public"."enum_monitors_aggregation";
  DROP TYPE "public"."enum_monitors_aggregation_quorum_unit";
  DROP TYPE "public"."enum_monitors_aggregation_latency";`)
}
