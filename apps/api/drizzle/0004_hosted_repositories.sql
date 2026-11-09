-- Hosted repositories (ADR-0546): each belongs to one namespace under a name
-- unique within it, and storage names it by its immutable id. A move or a
-- rename leaves an alias for the old <namespace>/<name>.
CREATE TABLE "repository" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "repository_namespace_id_name_unique" UNIQUE("namespace_id","name"),
	CONSTRAINT "repository_id_format" CHECK ("repository"."id" ~ '^[a-z0-9]{16}$'),
	CONSTRAINT "repository_name_format" CHECK ("repository"."name" ~ '^[a-z0-9][a-z0-9._-]{0,99}$' and "repository"."name" !~ '\.git$')
);
--> statement-breakpoint
CREATE TABLE "repository_alias" (
	"namespace_id" text NOT NULL,
	"name" text NOT NULL,
	"repository_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "repository_alias_namespace_id_name_pk" PRIMARY KEY("namespace_id","name")
);
--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_namespace_id_namespace_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_alias" ADD CONSTRAINT "repository_alias_namespace_id_namespace_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_alias" ADD CONSTRAINT "repository_alias_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_alias_repository_id_idx" ON "repository_alias" USING btree ("repository_id");