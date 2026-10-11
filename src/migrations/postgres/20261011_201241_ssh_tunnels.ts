import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_ssh_tunnels_auth_method" AS ENUM('password', 'privateKey');
  CREATE TABLE "ssh_tunnels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"host" varchar NOT NULL,
  	"port" numeric DEFAULT 22 NOT NULL,
  	"username" varchar NOT NULL,
  	"auth_method" "enum_ssh_tunnels_auth_method" DEFAULT 'password' NOT NULL,
  	"password" varchar,
  	"private_key" varchar,
  	"passphrase" varchar,
  	"known_host_fingerprint" varchar NOT NULL,
  	"has_password" boolean DEFAULT false,
  	"has_private_key" boolean DEFAULT false,
  	"has_passphrase" boolean DEFAULT false,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "monitors" ADD COLUMN "ssh_tunnel_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "ssh_tunnels_id" integer;
  ALTER TABLE "ssh_tunnels" ADD CONSTRAINT "ssh_tunnels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "ssh_tunnels_organization_idx" ON "ssh_tunnels" USING btree ("organization_id");
  CREATE INDEX "ssh_tunnels_updated_at_idx" ON "ssh_tunnels" USING btree ("updated_at");
  CREATE INDEX "ssh_tunnels_created_at_idx" ON "ssh_tunnels" USING btree ("created_at");
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_ssh_tunnel_id_ssh_tunnels_id_fk" FOREIGN KEY ("ssh_tunnel_id") REFERENCES "public"."ssh_tunnels"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ssh_tunnels_fk" FOREIGN KEY ("ssh_tunnels_id") REFERENCES "public"."ssh_tunnels"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "monitors_ssh_tunnel_idx" ON "monitors" USING btree ("ssh_tunnel_id");
  CREATE INDEX "payload_locked_documents_rels_ssh_tunnels_id_idx" ON "payload_locked_documents_rels" USING btree ("ssh_tunnels_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "ssh_tunnels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "ssh_tunnels" CASCADE;
  ALTER TABLE "monitors" DROP CONSTRAINT "monitors_ssh_tunnel_id_ssh_tunnels_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_ssh_tunnels_fk";
  
  DROP INDEX "monitors_ssh_tunnel_idx";
  DROP INDEX "payload_locked_documents_rels_ssh_tunnels_id_idx";
  ALTER TABLE "monitors" DROP COLUMN "ssh_tunnel_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "ssh_tunnels_id";
  DROP TYPE "public"."enum_ssh_tunnels_auth_method";`)
}
