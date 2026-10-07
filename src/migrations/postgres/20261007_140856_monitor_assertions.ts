import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_monitors_assertions_kind" AS ENUM('status', 'header', 'textBody', 'jsonBody', 'dnsRecord');
  CREATE TYPE "public"."enum_monitors_assertions_comparator" AS ENUM('eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'empty', 'not_empty', 'matches', 'not_matches');
  CREATE TABLE "monitors_assertions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"kind" "enum_monitors_assertions_kind",
  	"target" varchar,
  	"comparator" "enum_monitors_assertions_comparator",
  	"value" varchar
  );
  
  ALTER TABLE "heartbeats" ADD COLUMN "assertions" jsonb;
  ALTER TABLE "monitors_assertions" ADD CONSTRAINT "monitors_assertions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "monitors_assertions_order_idx" ON "monitors_assertions" USING btree ("_order");
  CREATE INDEX "monitors_assertions_parent_id_idx" ON "monitors_assertions" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "monitors_assertions" CASCADE;
  ALTER TABLE "heartbeats" DROP COLUMN "assertions";
  DROP TYPE "public"."enum_monitors_assertions_kind";
  DROP TYPE "public"."enum_monitors_assertions_comparator";`)
}
