import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_declared_incidents_timeline_type" ADD VALUE 'title_changed';
  ALTER TYPE "public"."enum_declared_incidents_timeline_type" ADD VALUE 'summary_changed';
  ALTER TYPE "public"."enum_declared_incidents_timeline_type" ADD VALUE 'started_changed';
  ALTER TYPE "public"."enum_declared_incidents_timeline_type" ADD VALUE 'action_item_added';
  ALTER TYPE "public"."enum_declared_incidents_timeline_type" ADD VALUE 'action_item_done';
  CREATE TABLE "declared_incidents_postmortem_action_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"owner_id" integer,
  	"due_date" varchar,
  	"done" boolean DEFAULT false,
  	"ticket_url" varchar
  );
  
  ALTER TABLE "declared_incidents_postmortem_action_items" ADD CONSTRAINT "declared_incidents_postmortem_action_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "declared_incidents_postmortem_action_items" ADD CONSTRAINT "declared_incidents_postmortem_action_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."declared_incidents"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "declared_incidents_postmortem_action_items_order_idx" ON "declared_incidents_postmortem_action_items" USING btree ("_order");
  CREATE INDEX "declared_incidents_postmortem_action_items_parent_id_idx" ON "declared_incidents_postmortem_action_items" USING btree ("_parent_id");
  CREATE INDEX "declared_incidents_postmortem_action_items_owner_idx" ON "declared_incidents_postmortem_action_items" USING btree ("owner_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "declared_incidents_postmortem_action_items" CASCADE;
  ALTER TABLE "declared_incidents_timeline" ALTER COLUMN "type" SET DATA TYPE text;
  DROP TYPE "public"."enum_declared_incidents_timeline_type";
  CREATE TYPE "public"."enum_declared_incidents_timeline_type" AS ENUM('declared', 'severity_changed', 'status_changed', 'commander_changed', 'note', 'linked', 'unlinked', 'postmortem_drafted', 'postmortem_approved', 'closed');
  ALTER TABLE "declared_incidents_timeline" ALTER COLUMN "type" SET DATA TYPE "public"."enum_declared_incidents_timeline_type" USING "type"::"public"."enum_declared_incidents_timeline_type";`)
}
