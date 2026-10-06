import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_proxies_protocol" AS ENUM('http', 'https', 'socks', 'socks5', 'socks5h', 'socks4');
  CREATE TYPE "public"."enum_docker_hosts_connection_type" AS ENUM('socket', 'tcp');
  ALTER TYPE "public"."enum_monitors_type" ADD VALUE 'docker' BEFORE 'grpc-keyword';
  CREATE TABLE "monitors_tags" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"tag_id" integer NOT NULL,
  	"value" varchar
  );
  
  CREATE TABLE "tags" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"color" varchar DEFAULT '#4B5563' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "proxies" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"protocol" "enum_proxies_protocol" DEFAULT 'https' NOT NULL,
  	"host" varchar NOT NULL,
  	"port" numeric NOT NULL,
  	"auth" boolean DEFAULT false,
  	"username" varchar,
  	"password" varchar,
  	"active" boolean DEFAULT true,
  	"default" boolean DEFAULT false,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "docker_hosts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"organization_id" integer NOT NULL,
  	"name" varchar NOT NULL,
  	"connection_type" "enum_docker_hosts_connection_type" DEFAULT 'socket' NOT NULL,
  	"socket_path" varchar DEFAULT '/var/run/docker.sock',
  	"url" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "monitors" ADD COLUMN "proxy_id" integer;
  ALTER TABLE "monitors" ADD COLUMN "docker_host_id" integer;
  ALTER TABLE "monitors" ADD COLUMN "docker_container" varchar;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "tags_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "proxies_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "docker_hosts_id" integer;
  ALTER TABLE "monitors_tags" ADD CONSTRAINT "monitors_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitors_tags" ADD CONSTRAINT "monitors_tags_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "proxies" ADD CONSTRAINT "proxies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "docker_hosts" ADD CONSTRAINT "docker_hosts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "monitors_tags_order_idx" ON "monitors_tags" USING btree ("_order");
  CREATE INDEX "monitors_tags_parent_id_idx" ON "monitors_tags" USING btree ("_parent_id");
  CREATE INDEX "monitors_tags_tag_idx" ON "monitors_tags" USING btree ("tag_id");
  CREATE INDEX "tags_organization_idx" ON "tags" USING btree ("organization_id");
  CREATE INDEX "tags_updated_at_idx" ON "tags" USING btree ("updated_at");
  CREATE INDEX "tags_created_at_idx" ON "tags" USING btree ("created_at");
  CREATE UNIQUE INDEX "organization_name_idx" ON "tags" USING btree ("organization_id","name");
  CREATE INDEX "proxies_organization_idx" ON "proxies" USING btree ("organization_id");
  CREATE INDEX "proxies_default_idx" ON "proxies" USING btree ("default");
  CREATE INDEX "proxies_updated_at_idx" ON "proxies" USING btree ("updated_at");
  CREATE INDEX "proxies_created_at_idx" ON "proxies" USING btree ("created_at");
  CREATE INDEX "organization_default_idx" ON "proxies" USING btree ("organization_id","default");
  CREATE INDEX "docker_hosts_organization_idx" ON "docker_hosts" USING btree ("organization_id");
  CREATE INDEX "docker_hosts_updated_at_idx" ON "docker_hosts" USING btree ("updated_at");
  CREATE INDEX "docker_hosts_created_at_idx" ON "docker_hosts" USING btree ("created_at");
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_proxy_id_proxies_id_fk" FOREIGN KEY ("proxy_id") REFERENCES "public"."proxies"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "monitors" ADD CONSTRAINT "monitors_docker_host_id_docker_hosts_id_fk" FOREIGN KEY ("docker_host_id") REFERENCES "public"."docker_hosts"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_tags_fk" FOREIGN KEY ("tags_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_proxies_fk" FOREIGN KEY ("proxies_id") REFERENCES "public"."proxies"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_docker_hosts_fk" FOREIGN KEY ("docker_hosts_id") REFERENCES "public"."docker_hosts"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "monitors_proxy_idx" ON "monitors" USING btree ("proxy_id");
  CREATE INDEX "monitors_docker_host_idx" ON "monitors" USING btree ("docker_host_id");
  CREATE INDEX "payload_locked_documents_rels_tags_id_idx" ON "payload_locked_documents_rels" USING btree ("tags_id");
  CREATE INDEX "payload_locked_documents_rels_proxies_id_idx" ON "payload_locked_documents_rels" USING btree ("proxies_id");
  CREATE INDEX "payload_locked_documents_rels_docker_hosts_id_idx" ON "payload_locked_documents_rels" USING btree ("docker_hosts_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "monitors_tags" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "tags" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "proxies" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "docker_hosts" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "monitors_tags" CASCADE;
  DROP TABLE "tags" CASCADE;
  DROP TABLE "proxies" CASCADE;
  DROP TABLE "docker_hosts" CASCADE;
  ALTER TABLE "monitors" DROP CONSTRAINT "monitors_proxy_id_proxies_id_fk";
  
  ALTER TABLE "monitors" DROP CONSTRAINT "monitors_docker_host_id_docker_hosts_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_tags_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_proxies_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_docker_hosts_fk";
  
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE text;
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::text;
  DROP TYPE "public"."enum_monitors_type";
  CREATE TYPE "public"."enum_monitors_type" AS ENUM('http', 'keyword', 'json-query', 'port', 'ping', 'dns', 'push', 'group', 'manual', 'grpc-keyword', 'websocket-upgrade', 'mqtt', 'kafka-producer', 'rabbitmq', 'smtp', 'snmp', 'ntp', 'sftp', 'radius', 'tailscale-ping', 'real-browser', 'mysql', 'postgres', 'sqlserver', 'mongodb', 'redis', 'steam', 'gamedig');
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DEFAULT 'http'::"public"."enum_monitors_type";
  ALTER TABLE "monitors" ALTER COLUMN "type" SET DATA TYPE "public"."enum_monitors_type" USING "type"::"public"."enum_monitors_type";
  DROP INDEX "monitors_proxy_idx";
  DROP INDEX "monitors_docker_host_idx";
  DROP INDEX "payload_locked_documents_rels_tags_id_idx";
  DROP INDEX "payload_locked_documents_rels_proxies_id_idx";
  DROP INDEX "payload_locked_documents_rels_docker_hosts_id_idx";
  ALTER TABLE "monitors" DROP COLUMN "proxy_id";
  ALTER TABLE "monitors" DROP COLUMN "docker_host_id";
  ALTER TABLE "monitors" DROP COLUMN "docker_container";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "tags_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "proxies_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "docker_hosts_id";
  DROP TYPE "public"."enum_proxies_protocol";
  DROP TYPE "public"."enum_docker_hosts_connection_type";`)
}
