import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "auth_accounts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"user_id" integer NOT NULL,
  	"provider" varchar NOT NULL,
  	"provider_account_id" varchar NOT NULL,
  	"email" varchar,
  	"name" varchar,
  	"last_login_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "auth_accounts_id" integer;
  ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");
  CREATE INDEX "auth_accounts_provider_idx" ON "auth_accounts" USING btree ("provider");
  CREATE INDEX "auth_accounts_updated_at_idx" ON "auth_accounts" USING btree ("updated_at");
  CREATE INDEX "auth_accounts_created_at_idx" ON "auth_accounts" USING btree ("created_at");
  CREATE UNIQUE INDEX "provider_providerAccountId_idx" ON "auth_accounts" USING btree ("provider","provider_account_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_auth_accounts_fk" FOREIGN KEY ("auth_accounts_id") REFERENCES "public"."auth_accounts"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_auth_accounts_id_idx" ON "payload_locked_documents_rels" USING btree ("auth_accounts_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "auth_accounts" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "auth_accounts" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_auth_accounts_fk";
  
  DROP INDEX "payload_locked_documents_rels_auth_accounts_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "auth_accounts_id";`)
}
