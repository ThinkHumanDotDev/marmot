import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_pages" ADD COLUMN "theme_preset" varchar DEFAULT 'default';
  ALTER TABLE "status_pages" ADD COLUMN "theme_overrides" jsonb;
  ALTER TABLE "status_pages" ADD COLUMN "banner_text" varchar;
  ALTER TABLE "status_pages" ADD COLUMN "logo_dark_id" integer;
  ALTER TABLE "status_pages" ADD COLUMN "favicon_id" integer;
  ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_logo_dark_id_media_id_fk" FOREIGN KEY ("logo_dark_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_favicon_id_media_id_fk" FOREIGN KEY ("favicon_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "status_pages_logo_dark_idx" ON "status_pages" USING btree ("logo_dark_id");
  CREATE INDEX "status_pages_favicon_idx" ON "status_pages" USING btree ("favicon_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_pages" DROP CONSTRAINT "status_pages_logo_dark_id_media_id_fk";
  
  ALTER TABLE "status_pages" DROP CONSTRAINT "status_pages_favicon_id_media_id_fk";
  
  DROP INDEX "status_pages_logo_dark_idx";
  DROP INDEX "status_pages_favicon_idx";
  ALTER TABLE "status_pages" DROP COLUMN "theme_preset";
  ALTER TABLE "status_pages" DROP COLUMN "theme_overrides";
  ALTER TABLE "status_pages" DROP COLUMN "banner_text";
  ALTER TABLE "status_pages" DROP COLUMN "logo_dark_id";
  ALTER TABLE "status_pages" DROP COLUMN "favicon_id";`)
}
