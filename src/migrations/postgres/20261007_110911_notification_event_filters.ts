import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_notifications_events" AS ENUM('down', 'up', 'degraded', 'reminder', 'certificate', 'maintenance');
  CREATE TABLE "notifications_events" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_notifications_events",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  ALTER TABLE "notifications_events" ADD CONSTRAINT "notifications_events_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "notifications_events_order_idx" ON "notifications_events" USING btree ("order");
  CREATE INDEX "notifications_events_parent_idx" ON "notifications_events" USING btree ("parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "notifications_events" CASCADE;
  DROP TYPE "public"."enum_notifications_events";`)
}
