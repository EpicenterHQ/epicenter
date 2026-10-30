-- Per-repository grants: the owner lets one person outside the namespace
-- read or write one repository. A grant names the repository by id, so it
-- follows a rename or a move.
CREATE TABLE "repository_grant" (
	"repository_id" text NOT NULL,
	"account_id" text NOT NULL,
	"level" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "repository_grant_repository_id_account_id_pk" PRIMARY KEY("repository_id","account_id"),
	CONSTRAINT "repository_grant_level" CHECK ("repository_grant"."level" in ('read', 'write'))
);
--> statement-breakpoint
ALTER TABLE "repository_grant" ADD CONSTRAINT "repository_grant_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_grant" ADD CONSTRAINT "repository_grant_account_id_user_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_grant_account_id_idx" ON "repository_grant" USING btree ("account_id");