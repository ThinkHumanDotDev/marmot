import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_sso_connections_group_roles_role" AS ENUM('owner', 'admin', 'member', 'viewer');
  CREATE TABLE "sso_connections_group_roles" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"group" varchar NOT NULL,
  	"role" "enum_sso_connections_group_roles_role" DEFAULT 'member' NOT NULL
  );
  
  ALTER TABLE "sso_connections" ADD COLUMN "group_claim" varchar;
  ALTER TABLE "sso_connections" ADD COLUMN "allowed_groups" varchar;
  ALTER TABLE "sso_connections_group_roles" ADD CONSTRAINT "sso_connections_group_roles_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "sso_connections_group_roles_order_idx" ON "sso_connections_group_roles" USING btree ("_order");
  CREATE INDEX "sso_connections_group_roles_parent_id_idx" ON "sso_connections_group_roles" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "sso_connections_group_roles" CASCADE;
  ALTER TABLE "sso_connections" DROP COLUMN "group_claim";
  ALTER TABLE "sso_connections" DROP COLUMN "allowed_groups";
  DROP TYPE "public"."enum_sso_connections_group_roles_role";`)
}
