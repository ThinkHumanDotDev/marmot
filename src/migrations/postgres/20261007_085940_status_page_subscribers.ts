import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_status_pages_subscriptions_channels" AS ENUM('email', 'sms', 'webhook', 'slack');
  CREATE TYPE "public"."enum_status_pages_subscriptions_delivery_mode" AS ENUM('review', 'auto');
  CREATE TYPE "public"."enum_status_page_subscribers_channel" AS ENUM('email', 'sms', 'webhook', 'slack');
  CREATE TYPE "public"."enum_status_page_subscribers_source" AS ENUM('self_signup', 'added_by_owner', 'import');
  CREATE TYPE "public"."enum_status_page_subscribers_locale" AS ENUM('en');
  CREATE TYPE "public"."enum_subscriber_notifications_channels" AS ENUM('email', 'sms', 'webhook', 'slack');
  CREATE TYPE "public"."enum_subscriber_notifications_event" AS ENUM('incident_opened', 'incident_updated', 'incident_resolved', 'maintenance_scheduled', 'maintenance_reminder', 'maintenance_started', 'maintenance_updated', 'maintenance_completed', 'maintenance_cancelled');
  CREATE TYPE "public"."enum_subscriber_notifications_state" AS ENUM('pending_review', 'sending', 'sent', 'partially_failed', 'failed', 'discarded');
  CREATE TYPE "public"."enum_subscriber_deliveries_channel" AS ENUM('email', 'sms', 'webhook', 'slack');
  CREATE TYPE "public"."enum_subscriber_deliveries_state" AS ENUM('queued', 'retrying', 'sent', 'failed', 'skipped');
  CREATE TABLE "status_pages_subscriptions_channels" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_status_pages_subscriptions_channels",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "status_page_subscribers_headers" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"value" varchar
  );
  
  CREATE TABLE "status_page_subscribers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"status_page_id" integer NOT NULL,
  	"channel" "enum_status_page_subscribers_channel" NOT NULL,
  	"target" varchar NOT NULL,
  	"source" "enum_status_page_subscribers_source" DEFAULT 'self_signup',
  	"confirmed_at" timestamp(3) with time zone,
  	"locale" "enum_status_page_subscribers_locale",
  	"token" varchar,
  	"secret" varchar,
  	"verification_code_hash" varchar,
  	"verification_expires_at" timestamp(3) with time zone,
  	"verification_attempts" numeric DEFAULT 0,
  	"verification_sent_at" timestamp(3) with time zone,
  	"last_delivered_at" timestamp(3) with time zone,
  	"last_error" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "status_page_subscribers_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "subscriber_notifications_channels" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_subscriber_notifications_channels",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "subscriber_notifications" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"status_page_id" integer NOT NULL,
  	"dedupe_key" varchar NOT NULL,
  	"event" "enum_subscriber_notifications_event" NOT NULL,
  	"state" "enum_subscriber_notifications_state" DEFAULT 'pending_review' NOT NULL,
  	"title" varchar NOT NULL,
  	"status" varchar,
  	"message" varchar,
  	"window_start" timestamp(3) with time zone,
  	"window_end" timestamp(3) with time zone,
  	"window_reminder_minutes" numeric,
  	"incident_id" integer,
  	"incident_update_id" varchar,
  	"maintenance_id" integer,
  	"occurrence_id" integer,
  	"event_public_id" varchar,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"recipient_count" numeric,
  	"sending_started_at" timestamp(3) with time zone,
  	"completed_at" timestamp(3) with time zone,
  	"approved_by_id" integer,
  	"approved_at" timestamp(3) with time zone,
  	"discarded_by_id" integer,
  	"discarded_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "subscriber_notifications_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "subscriber_deliveries" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"notification_id" integer NOT NULL,
  	"subscriber_id" integer NOT NULL,
  	"channel" "enum_subscriber_deliveries_channel" NOT NULL,
  	"state" "enum_subscriber_deliveries_state" DEFAULT 'queued' NOT NULL,
  	"attempts" numeric DEFAULT 0,
  	"error" varchar,
  	"sent_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "status_pages" ADD COLUMN "subscriptions_enabled" boolean DEFAULT false;
  ALTER TABLE "status_pages" ADD COLUMN "subscriptions_delivery_mode" "enum_status_pages_subscriptions_delivery_mode" DEFAULT 'review';
  ALTER TABLE "status_pages" ADD COLUMN "subscriptions_sms_channel_id" integer;
  ALTER TABLE "status_pages" ADD COLUMN "subscriptions_sms_max_segments" numeric DEFAULT 2;
  ALTER TABLE "status_pages" ADD COLUMN "subscriptions_sms_templates_incident_opened" varchar;
  ALTER TABLE "status_pages" ADD COLUMN "subscriptions_sms_templates_incident_updated" varchar;
  ALTER TABLE "status_pages" ADD COLUMN "subscriptions_sms_templates_maintenance_scheduled" varchar;
  ALTER TABLE "status_pages" ADD COLUMN "subscriptions_sms_templates_maintenance_updated" varchar;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "status_page_subscribers_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "subscriber_notifications_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "subscriber_deliveries_id" integer;
  ALTER TABLE "status_pages_subscriptions_channels" ADD CONSTRAINT "status_pages_subscriptions_channels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_page_subscribers_headers" ADD CONSTRAINT "status_page_subscribers_headers_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."status_page_subscribers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_page_subscribers" ADD CONSTRAINT "status_page_subscribers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "status_page_subscribers" ADD CONSTRAINT "status_page_subscribers_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "status_page_subscribers_texts" ADD CONSTRAINT "status_page_subscribers_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."status_page_subscribers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "subscriber_notifications_channels" ADD CONSTRAINT "subscriber_notifications_channels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."subscriber_notifications"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "subscriber_notifications" ADD CONSTRAINT "subscriber_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriber_notifications" ADD CONSTRAINT "subscriber_notifications_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriber_notifications" ADD CONSTRAINT "subscriber_notifications_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriber_notifications" ADD CONSTRAINT "subscriber_notifications_maintenance_id_maintenance_id_fk" FOREIGN KEY ("maintenance_id") REFERENCES "public"."maintenance"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriber_notifications" ADD CONSTRAINT "subscriber_notifications_occurrence_id_maintenance_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."maintenance_occurrences"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriber_notifications" ADD CONSTRAINT "subscriber_notifications_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriber_notifications" ADD CONSTRAINT "subscriber_notifications_discarded_by_id_users_id_fk" FOREIGN KEY ("discarded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriber_notifications_texts" ADD CONSTRAINT "subscriber_notifications_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."subscriber_notifications"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "subscriber_deliveries" ADD CONSTRAINT "subscriber_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriber_deliveries" ADD CONSTRAINT "subscriber_deliveries_notification_id_subscriber_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."subscriber_notifications"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriber_deliveries" ADD CONSTRAINT "subscriber_deliveries_subscriber_id_status_page_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."status_page_subscribers"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "status_pages_subscriptions_channels_order_idx" ON "status_pages_subscriptions_channels" USING btree ("order");
  CREATE INDEX "status_pages_subscriptions_channels_parent_idx" ON "status_pages_subscriptions_channels" USING btree ("parent_id");
  CREATE INDEX "status_page_subscribers_headers_order_idx" ON "status_page_subscribers_headers" USING btree ("_order");
  CREATE INDEX "status_page_subscribers_headers_parent_id_idx" ON "status_page_subscribers_headers" USING btree ("_parent_id");
  CREATE INDEX "status_page_subscribers_organization_idx" ON "status_page_subscribers" USING btree ("organization_id");
  CREATE INDEX "status_page_subscribers_status_page_idx" ON "status_page_subscribers" USING btree ("status_page_id");
  CREATE INDEX "status_page_subscribers_target_idx" ON "status_page_subscribers" USING btree ("target");
  CREATE INDEX "status_page_subscribers_confirmed_at_idx" ON "status_page_subscribers" USING btree ("confirmed_at");
  CREATE INDEX "status_page_subscribers_token_idx" ON "status_page_subscribers" USING btree ("token");
  CREATE INDEX "status_page_subscribers_updated_at_idx" ON "status_page_subscribers" USING btree ("updated_at");
  CREATE INDEX "status_page_subscribers_created_at_idx" ON "status_page_subscribers" USING btree ("created_at");
  CREATE UNIQUE INDEX "statusPage_channel_target_idx" ON "status_page_subscribers" USING btree ("status_page_id","channel","target");
  CREATE INDEX "statusPage_confirmedAt_idx" ON "status_page_subscribers" USING btree ("status_page_id","confirmed_at");
  CREATE INDEX "status_page_subscribers_texts_order_parent" ON "status_page_subscribers_texts" USING btree ("order","parent_id");
  CREATE INDEX "subscriber_notifications_channels_order_idx" ON "subscriber_notifications_channels" USING btree ("order");
  CREATE INDEX "subscriber_notifications_channels_parent_idx" ON "subscriber_notifications_channels" USING btree ("parent_id");
  CREATE INDEX "subscriber_notifications_organization_idx" ON "subscriber_notifications" USING btree ("organization_id");
  CREATE INDEX "subscriber_notifications_status_page_idx" ON "subscriber_notifications" USING btree ("status_page_id");
  CREATE UNIQUE INDEX "subscriber_notifications_dedupe_key_idx" ON "subscriber_notifications" USING btree ("dedupe_key");
  CREATE INDEX "subscriber_notifications_state_idx" ON "subscriber_notifications" USING btree ("state");
  CREATE INDEX "subscriber_notifications_incident_idx" ON "subscriber_notifications" USING btree ("incident_id");
  CREATE INDEX "subscriber_notifications_maintenance_idx" ON "subscriber_notifications" USING btree ("maintenance_id");
  CREATE INDEX "subscriber_notifications_occurrence_idx" ON "subscriber_notifications" USING btree ("occurrence_id");
  CREATE INDEX "subscriber_notifications_approved_by_idx" ON "subscriber_notifications" USING btree ("approved_by_id");
  CREATE INDEX "subscriber_notifications_discarded_by_idx" ON "subscriber_notifications" USING btree ("discarded_by_id");
  CREATE INDEX "subscriber_notifications_updated_at_idx" ON "subscriber_notifications" USING btree ("updated_at");
  CREATE INDEX "subscriber_notifications_created_at_idx" ON "subscriber_notifications" USING btree ("created_at");
  CREATE INDEX "statusPage_state_idx" ON "subscriber_notifications" USING btree ("status_page_id","state");
  CREATE INDEX "subscriber_notifications_texts_order_parent" ON "subscriber_notifications_texts" USING btree ("order","parent_id");
  CREATE INDEX "subscriber_deliveries_organization_idx" ON "subscriber_deliveries" USING btree ("organization_id");
  CREATE INDEX "subscriber_deliveries_notification_idx" ON "subscriber_deliveries" USING btree ("notification_id");
  CREATE INDEX "subscriber_deliveries_subscriber_idx" ON "subscriber_deliveries" USING btree ("subscriber_id");
  CREATE INDEX "subscriber_deliveries_updated_at_idx" ON "subscriber_deliveries" USING btree ("updated_at");
  CREATE INDEX "subscriber_deliveries_created_at_idx" ON "subscriber_deliveries" USING btree ("created_at");
  CREATE UNIQUE INDEX "notification_subscriber_idx" ON "subscriber_deliveries" USING btree ("notification_id","subscriber_id");
  CREATE INDEX "notification_state_idx" ON "subscriber_deliveries" USING btree ("notification_id","state");
  ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_subscriptions_sms_channel_id_notifications_id_fk" FOREIGN KEY ("subscriptions_sms_channel_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_status_page_subscribers_fk" FOREIGN KEY ("status_page_subscribers_id") REFERENCES "public"."status_page_subscribers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_subscriber_notifications_fk" FOREIGN KEY ("subscriber_notifications_id") REFERENCES "public"."subscriber_notifications"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_subscriber_deliveries_fk" FOREIGN KEY ("subscriber_deliveries_id") REFERENCES "public"."subscriber_deliveries"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "status_pages_subscriptions_subscriptions_sms_channel_idx" ON "status_pages" USING btree ("subscriptions_sms_channel_id");
  CREATE INDEX "payload_locked_documents_rels_status_page_subscribers_id_idx" ON "payload_locked_documents_rels" USING btree ("status_page_subscribers_id");
  CREATE INDEX "payload_locked_documents_rels_subscriber_notifications_i_idx" ON "payload_locked_documents_rels" USING btree ("subscriber_notifications_id");
  CREATE INDEX "payload_locked_documents_rels_subscriber_deliveries_id_idx" ON "payload_locked_documents_rels" USING btree ("subscriber_deliveries_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "status_pages_subscriptions_channels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_page_subscribers_headers" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_page_subscribers" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "status_page_subscribers_texts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "subscriber_notifications_channels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "subscriber_notifications" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "subscriber_notifications_texts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "subscriber_deliveries" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "status_pages_subscriptions_channels" CASCADE;
  DROP TABLE "status_page_subscribers_headers" CASCADE;
  DROP TABLE "status_page_subscribers" CASCADE;
  DROP TABLE "status_page_subscribers_texts" CASCADE;
  DROP TABLE "subscriber_notifications_channels" CASCADE;
  DROP TABLE "subscriber_notifications" CASCADE;
  DROP TABLE "subscriber_notifications_texts" CASCADE;
  DROP TABLE "subscriber_deliveries" CASCADE;
  ALTER TABLE "status_pages" DROP CONSTRAINT "status_pages_subscriptions_sms_channel_id_notifications_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_status_page_subscribers_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_subscriber_notifications_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_subscriber_deliveries_fk";
  
  DROP INDEX "status_pages_subscriptions_subscriptions_sms_channel_idx";
  DROP INDEX "payload_locked_documents_rels_status_page_subscribers_id_idx";
  DROP INDEX "payload_locked_documents_rels_subscriber_notifications_i_idx";
  DROP INDEX "payload_locked_documents_rels_subscriber_deliveries_id_idx";
  ALTER TABLE "status_pages" DROP COLUMN "subscriptions_enabled";
  ALTER TABLE "status_pages" DROP COLUMN "subscriptions_delivery_mode";
  ALTER TABLE "status_pages" DROP COLUMN "subscriptions_sms_channel_id";
  ALTER TABLE "status_pages" DROP COLUMN "subscriptions_sms_max_segments";
  ALTER TABLE "status_pages" DROP COLUMN "subscriptions_sms_templates_incident_opened";
  ALTER TABLE "status_pages" DROP COLUMN "subscriptions_sms_templates_incident_updated";
  ALTER TABLE "status_pages" DROP COLUMN "subscriptions_sms_templates_maintenance_scheduled";
  ALTER TABLE "status_pages" DROP COLUMN "subscriptions_sms_templates_maintenance_updated";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "status_page_subscribers_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "subscriber_notifications_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "subscriber_deliveries_id";
  DROP TYPE "public"."enum_status_pages_subscriptions_channels";
  DROP TYPE "public"."enum_status_pages_subscriptions_delivery_mode";
  DROP TYPE "public"."enum_status_page_subscribers_channel";
  DROP TYPE "public"."enum_status_page_subscribers_source";
  DROP TYPE "public"."enum_status_page_subscribers_locale";
  DROP TYPE "public"."enum_subscriber_notifications_channels";
  DROP TYPE "public"."enum_subscriber_notifications_event";
  DROP TYPE "public"."enum_subscriber_notifications_state";
  DROP TYPE "public"."enum_subscriber_deliveries_channel";
  DROP TYPE "public"."enum_subscriber_deliveries_state";`)
}
