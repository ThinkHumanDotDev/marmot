import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_audit_logs_actor_type" AS ENUM('user', 'apiKey', 'mcp', 'system');
  ALTER TABLE "audit_logs" ADD COLUMN "actor_type" "enum_audit_logs_actor_type";
  ALTER TABLE "audit_logs" ADD COLUMN "actor_ref" varchar;
  ALTER TABLE "audit_logs" ADD COLUMN "actor_label" varchar;
  ALTER TABLE "audit_logs" ADD COLUMN "entity_type" varchar;
  ALTER TABLE "audit_logs" ADD COLUMN "entity_id" varchar;
  ALTER TABLE "audit_logs" ADD COLUMN "entity_label" varchar;
  ALTER TABLE "audit_logs" ADD COLUMN "changed_fields" jsonb;
  ALTER TABLE "audit_logs" ADD COLUMN "before" jsonb;
  ALTER TABLE "audit_logs" ADD COLUMN "after" jsonb;
  CREATE INDEX "audit_logs_actor_type_idx" ON "audit_logs" USING btree ("actor_type");
  CREATE INDEX "audit_logs_actor_ref_idx" ON "audit_logs" USING btree ("actor_ref");
  CREATE INDEX "audit_logs_entity_type_idx" ON "audit_logs" USING btree ("entity_type");
  CREATE INDEX "organization_createdAt_idx" ON "audit_logs" USING btree ("organization_id","created_at");
  CREATE INDEX "entityType_entityId_idx" ON "audit_logs" USING btree ("entity_type","entity_id");`)
  // Rows written before #121 only had the `actor` relationship.
  await db.execute(sql`
  UPDATE "audit_logs" SET "actor_type" = 'user', "actor_ref" = "actor_id"::varchar WHERE "actor_id" IS NOT NULL;
  UPDATE "audit_logs" SET "actor_type" = 'system' WHERE "actor_id" IS NULL;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "audit_logs_actor_type_idx";
  DROP INDEX "audit_logs_actor_ref_idx";
  DROP INDEX "audit_logs_entity_type_idx";
  DROP INDEX "organization_createdAt_idx";
  DROP INDEX "entityType_entityId_idx";
  ALTER TABLE "audit_logs" DROP COLUMN "actor_type";
  ALTER TABLE "audit_logs" DROP COLUMN "actor_ref";
  ALTER TABLE "audit_logs" DROP COLUMN "actor_label";
  ALTER TABLE "audit_logs" DROP COLUMN "entity_type";
  ALTER TABLE "audit_logs" DROP COLUMN "entity_id";
  ALTER TABLE "audit_logs" DROP COLUMN "entity_label";
  ALTER TABLE "audit_logs" DROP COLUMN "changed_fields";
  ALTER TABLE "audit_logs" DROP COLUMN "before";
  ALTER TABLE "audit_logs" DROP COLUMN "after";
  DROP TYPE "public"."enum_audit_logs_actor_type";`)
}
