import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_organizations_subscription_status" AS ENUM('none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid');
  ALTER TABLE "organizations" ADD COLUMN "subscription_status" "enum_organizations_subscription_status" DEFAULT 'none';
  ALTER TABLE "organizations" ADD COLUMN "stripe_customer_id" varchar;
  ALTER TABLE "organizations" ADD COLUMN "stripe_subscription_id" varchar;
  CREATE INDEX "organizations_stripe_customer_id_idx" ON "organizations" USING btree ("stripe_customer_id");
  CREATE INDEX "organizations_stripe_subscription_id_idx" ON "organizations" USING btree ("stripe_subscription_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "organizations_stripe_customer_id_idx";
  DROP INDEX "organizations_stripe_subscription_id_idx";
  ALTER TABLE "organizations" DROP COLUMN "subscription_status";
  ALTER TABLE "organizations" DROP COLUMN "stripe_customer_id";
  ALTER TABLE "organizations" DROP COLUMN "stripe_subscription_id";
  DROP TYPE "public"."enum_organizations_subscription_status";`)
}
