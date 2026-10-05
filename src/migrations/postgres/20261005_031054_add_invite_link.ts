import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_organizations_invite_link_role" AS ENUM('owner', 'admin', 'member', 'viewer');
  ALTER TABLE "organizations" ADD COLUMN "invite_link_token" varchar;
  ALTER TABLE "organizations" ADD COLUMN "invite_link_role" "enum_organizations_invite_link_role" DEFAULT 'member';
  CREATE INDEX "organizations_invite_link_token_idx" ON "organizations" USING btree ("invite_link_token");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "organizations_invite_link_token_idx";
  ALTER TABLE "organizations" DROP COLUMN "invite_link_token";
  ALTER TABLE "organizations" DROP COLUMN "invite_link_role";
  DROP TYPE "public"."enum_organizations_invite_link_role";`)
}
