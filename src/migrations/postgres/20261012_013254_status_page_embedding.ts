import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_status_pages_allow_embedding" AS ENUM('off', 'any', 'origins');
  CREATE TABLE "status_pages_embed_origins" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"origin" varchar
  );
  
  ALTER TABLE "status_pages" ADD COLUMN "allow_embedding" "enum_status_pages_allow_embedding" DEFAULT 'off';
  ALTER TABLE "status_pages_embed_origins" ADD CONSTRAINT "status_pages_embed_origins_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "status_pages_embed_origins_order_idx" ON "status_pages_embed_origins" USING btree ("_order");
  CREATE INDEX "status_pages_embed_origins_parent_id_idx" ON "status_pages_embed_origins" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "status_pages_embed_origins" CASCADE;
  ALTER TABLE "status_pages" DROP COLUMN "allow_embedding";
  DROP TYPE "public"."enum_status_pages_allow_embedding";`)
}
