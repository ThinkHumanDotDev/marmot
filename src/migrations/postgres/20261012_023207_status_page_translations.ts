import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_status_pages_additional_locales" AS ENUM('en', 'fr', 'de', 'es');
  CREATE TYPE "public"."enum_status_pages_default_locale" AS ENUM('en', 'fr', 'de', 'es');
  CREATE TYPE "public"."enum_status_pages_time_zone_mode" AS ENUM('visitor', 'page');
  ALTER TYPE "public"."enum_status_page_subscribers_locale" ADD VALUE 'fr';
  ALTER TYPE "public"."enum_status_page_subscribers_locale" ADD VALUE 'de';
  ALTER TYPE "public"."enum_status_page_subscribers_locale" ADD VALUE 'es';
  CREATE TABLE "status_pages_additional_locales" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_status_pages_additional_locales",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  ALTER TABLE "status_pages" ADD COLUMN "default_locale" "enum_status_pages_default_locale" DEFAULT 'en';
  ALTER TABLE "status_pages" ADD COLUMN "time_zone_mode" "enum_status_pages_time_zone_mode" DEFAULT 'visitor';
  ALTER TABLE "status_pages" ADD COLUMN "time_zone" varchar;
  ALTER TABLE "status_pages_additional_locales" ADD CONSTRAINT "status_pages_additional_locales_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "status_pages_additional_locales_order_idx" ON "status_pages_additional_locales" USING btree ("order");
  CREATE INDEX "status_pages_additional_locales_parent_idx" ON "status_pages_additional_locales" USING btree ("parent_id");
  ALTER TABLE "status_pages" DROP COLUMN "language";
  DROP TYPE "public"."enum_status_pages_language";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_status_pages_language" AS ENUM('auto', 'en');
  DROP TABLE "status_pages_additional_locales" CASCADE;
  ALTER TABLE "status_page_subscribers" ALTER COLUMN "locale" SET DATA TYPE text;
  DROP TYPE "public"."enum_status_page_subscribers_locale";
  CREATE TYPE "public"."enum_status_page_subscribers_locale" AS ENUM('en');
  ALTER TABLE "status_page_subscribers" ALTER COLUMN "locale" SET DATA TYPE "public"."enum_status_page_subscribers_locale" USING "locale"::"public"."enum_status_page_subscribers_locale";
  ALTER TABLE "status_pages" ADD COLUMN "language" "enum_status_pages_language" DEFAULT 'en';
  ALTER TABLE "status_pages" DROP COLUMN "default_locale";
  ALTER TABLE "status_pages" DROP COLUMN "time_zone_mode";
  ALTER TABLE "status_pages" DROP COLUMN "time_zone";
  DROP TYPE "public"."enum_status_pages_additional_locales";
  DROP TYPE "public"."enum_status_pages_default_locale";
  DROP TYPE "public"."enum_status_pages_time_zone_mode";`)
}
