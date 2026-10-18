import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_page_subscribers" ADD COLUMN "viewer_id" integer;
  ALTER TABLE "status_page_subscribers" ADD CONSTRAINT "status_page_subscribers_viewer_id_status_page_viewers_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."status_page_viewers"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "status_page_subscribers_viewer_idx" ON "status_page_subscribers" USING btree ("viewer_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_page_subscribers" DROP CONSTRAINT "status_page_subscribers_viewer_id_status_page_viewers_id_fk";
  
  DROP INDEX "status_page_subscribers_viewer_idx";
  ALTER TABLE "status_page_subscribers" DROP COLUMN "viewer_id";`)
}
