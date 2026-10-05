import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_instance_settings_entry_page" AS ENUM('dashboard', 'status-page');
  CREATE TABLE "instance_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"primary_base_url" varchar,
  	"allow_signup" boolean,
  	"entry_page" "enum_instance_settings_entry_page" DEFAULT 'dashboard',
  	"keep_data_period_days" numeric,
  	"trust_proxy" boolean DEFAULT false,
  	"steam_api_key" varchar,
  	"globalping_api_token" varchar,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "instance_settings_numbers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"number" numeric,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL
  );
  
  ALTER TABLE "instance_settings_numbers" ADD CONSTRAINT "instance_settings_numbers_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."instance_settings"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "instance_settings_numbers_order_parent_idx" ON "instance_settings_numbers" USING btree ("order","parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "instance_settings" CASCADE;
  DROP TABLE "instance_settings_numbers" CASCADE;
  DROP TYPE "public"."enum_instance_settings_entry_page";`)
}
