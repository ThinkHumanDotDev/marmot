import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_notification_sent_history_type" AS ENUM('certificate', 'domain');
  CREATE TABLE "notification_sent_history" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer,
  	"monitor_id" integer NOT NULL,
  	"type" "enum_notification_sent_history_type" NOT NULL,
  	"days" numeric NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "monitors" ADD COLUMN "domain_expiry_notification" boolean DEFAULT false;
  ALTER TABLE "monitors" ADD COLUMN "cert_info" jsonb;
  ALTER TABLE "monitors" ADD COLUMN "domain_expiry" jsonb;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "notification_sent_history_id" integer;
  ALTER TABLE "notification_sent_history" ADD CONSTRAINT "notification_sent_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notification_sent_history" ADD CONSTRAINT "notification_sent_history_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "notification_sent_history_organization_idx" ON "notification_sent_history" USING btree ("organization_id");
  CREATE INDEX "notification_sent_history_monitor_idx" ON "notification_sent_history" USING btree ("monitor_id");
  CREATE INDEX "notification_sent_history_updated_at_idx" ON "notification_sent_history" USING btree ("updated_at");
  CREATE INDEX "notification_sent_history_created_at_idx" ON "notification_sent_history" USING btree ("created_at");
  CREATE UNIQUE INDEX "type_monitor_days_idx" ON "notification_sent_history" USING btree ("type","monitor_id","days");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notification_sent_history_fk" FOREIGN KEY ("notification_sent_history_id") REFERENCES "public"."notification_sent_history"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_notification_sent_history__idx" ON "payload_locked_documents_rels" USING btree ("notification_sent_history_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "notification_sent_history" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "notification_sent_history" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_notification_sent_history_fk";
  
  DROP INDEX "payload_locked_documents_rels_notification_sent_history__idx";
  ALTER TABLE "monitors" DROP COLUMN "domain_expiry_notification";
  ALTER TABLE "monitors" DROP COLUMN "cert_info";
  ALTER TABLE "monitors" DROP COLUMN "domain_expiry";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "notification_sent_history_id";
  DROP TYPE "public"."enum_notification_sent_history_type";`)
}
