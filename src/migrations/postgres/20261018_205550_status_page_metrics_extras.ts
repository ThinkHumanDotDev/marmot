import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "status_pages_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"metrics_id" integer
  );
  
  ALTER TABLE "metrics" ADD COLUMN "show_threshold_state" boolean DEFAULT false;
  ALTER TABLE "status_pages_rels" ADD CONSTRAINT "status_pages_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "status_pages_rels" ADD CONSTRAINT "status_pages_rels_metrics_fk" FOREIGN KEY ("metrics_id") REFERENCES "public"."metrics"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "status_pages_rels_order_idx" ON "status_pages_rels" USING btree ("order");
  CREATE INDEX "status_pages_rels_parent_idx" ON "status_pages_rels" USING btree ("parent_id");
  CREATE INDEX "status_pages_rels_path_idx" ON "status_pages_rels" USING btree ("path");
  CREATE INDEX "status_pages_rels_metrics_id_idx" ON "status_pages_rels" USING btree ("metrics_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "status_pages_rels" CASCADE;
  ALTER TABLE "metrics" DROP COLUMN "show_threshold_state";`)
}
