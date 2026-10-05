import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "monitors_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"notifications_id" integer
  );
  
  CREATE TABLE "notifications" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"type" varchar NOT NULL,
  	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  	"is_default" boolean DEFAULT false,
  	"active" boolean DEFAULT true,
  	"last_sent_at" timestamp(3) with time zone,
  	"last_error" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "notifications_id" integer;
  ALTER TABLE "monitors_rels" ADD CONSTRAINT "monitors_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "monitors_rels" ADD CONSTRAINT "monitors_rels_notifications_fk" FOREIGN KEY ("notifications_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "monitors_rels_order_idx" ON "monitors_rels" USING btree ("order");
  CREATE INDEX "monitors_rels_parent_idx" ON "monitors_rels" USING btree ("parent_id");
  CREATE INDEX "monitors_rels_path_idx" ON "monitors_rels" USING btree ("path");
  CREATE INDEX "monitors_rels_notifications_id_idx" ON "monitors_rels" USING btree ("notifications_id");
  CREATE INDEX "notifications_organization_idx" ON "notifications" USING btree ("organization_id");
  CREATE INDEX "notifications_type_idx" ON "notifications" USING btree ("type");
  CREATE INDEX "notifications_is_default_idx" ON "notifications" USING btree ("is_default");
  CREATE INDEX "notifications_active_idx" ON "notifications" USING btree ("active");
  CREATE INDEX "notifications_updated_at_idx" ON "notifications" USING btree ("updated_at");
  CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");
  CREATE INDEX "organization_isDefault_idx" ON "notifications" USING btree ("organization_id","is_default");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notifications_fk" FOREIGN KEY ("notifications_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_notifications_id_idx" ON "payload_locked_documents_rels" USING btree ("notifications_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "notifications" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "monitors_rels" CASCADE;
  DROP TABLE "notifications" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_notifications_fk";
  
  DROP INDEX "payload_locked_documents_rels_notifications_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "notifications_id";`)
}
