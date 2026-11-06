-- Folders are shared directly with people (ADR-0811): a folder has members,
-- any of whom may own it, and no namespace owns it. Each repository becomes
-- the folder of the same id; its namespace's members and its grants become
-- the folder's members, already accepted; a repository named for an app's
-- client (the web's `repositoryName`) is attached to that app.
CREATE TABLE "folder" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "folder_id_format" CHECK ("folder"."id" ~ '^[a-z0-9]{16}$')
);
--> statement-breakpoint
CREATE TABLE "folder_member" (
	"folder_id" text NOT NULL,
	"account_id" text NOT NULL,
	"role" text NOT NULL,
	"shared_by" text,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "folder_member_folder_id_account_id_pk" PRIMARY KEY("folder_id","account_id"),
	CONSTRAINT "folder_member_role" CHECK ("folder_member"."role" in ('owner', 'writer', 'reader'))
);
--> statement-breakpoint
CREATE TABLE "folder_app" (
	"folder_id" text NOT NULL,
	"app" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "folder_app_folder_id_app_pk" PRIMARY KEY("folder_id","app")
);
--> statement-breakpoint
ALTER TABLE "folder_member" ADD CONSTRAINT "folder_member_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_member" ADD CONSTRAINT "folder_member_account_id_user_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_member" ADD CONSTRAINT "folder_member_shared_by_user_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_app" ADD CONSTRAINT "folder_app_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folder_member_account_id_idx" ON "folder_member" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "folder_app_app_idx" ON "folder_app" USING btree ("app");--> statement-breakpoint
INSERT INTO "folder" ("id", "created_at")
SELECT "id", "created_at" FROM "repository";
--> statement-breakpoint
INSERT INTO "folder_member" ("folder_id", "account_id", "role", "accepted_at", "created_at")
SELECT r."id", m."account_id", CASE m."role" WHEN 'owner' THEN 'owner' ELSE 'writer' END, now(), m."created_at"
FROM "repository" r
JOIN "namespace_member" m ON m."namespace_id" = r."namespace_id";
--> statement-breakpoint
INSERT INTO "folder_member" ("folder_id", "account_id", "role", "accepted_at", "created_at")
SELECT g."repository_id", g."account_id", CASE g."level" WHEN 'write' THEN 'writer' ELSE 'reader' END, now(), g."created_at"
FROM "repository_grant" g
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- A web app named its folder for its site (`todos` for todos.epicenter.so,
-- the host otherwise), and signs in as the reversed host.
INSERT INTO "folder_app" ("folder_id", "app")
SELECT r."id", c."client_id"
FROM "repository" r
JOIN "namespace" n ON n."id" = r."namespace_id" AND n."personal_account_id" IS NOT NULL
JOIN "oauth_client" c ON c."client_id" = 'so.epicenter.' || r."name"
	OR c."client_id" = (
		SELECT string_agg(t."part", '.' ORDER BY t."ord" DESC)
		FROM unnest(string_to_array(r."name", '.')) WITH ORDINALITY AS t("part", "ord")
	)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "blob_upload" DROP CONSTRAINT "blob_upload_repository_id_repository_id_fk";--> statement-breakpoint
ALTER TABLE "blob_upload" RENAME COLUMN "repository_id" TO "folder_id";--> statement-breakpoint
ALTER TABLE "blob_upload" RENAME CONSTRAINT "blob_upload_repository_id_oid_pk" TO "blob_upload_folder_id_oid_pk";--> statement-breakpoint
ALTER TABLE "blob_upload" ADD CONSTRAINT "blob_upload_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP TABLE "repository_grant" CASCADE;--> statement-breakpoint
DROP TABLE "repository" CASCADE;--> statement-breakpoint
DROP TRIGGER "user_personal_namespace" ON "user";--> statement-breakpoint
DROP FUNCTION "user_personal_namespace"();--> statement-breakpoint
DROP FUNCTION "create_personal_namespace"(text);--> statement-breakpoint
DROP FUNCTION "new_namespace_id"();--> statement-breakpoint
DROP TABLE "namespace_member" CASCADE;--> statement-breakpoint
DROP TABLE "namespace" CASCADE;--> statement-breakpoint
-- A folder lives while an accepted member remains (ADR-0811). When the last
-- one leaves, account deletion included, the folder goes with its shares,
-- attachments, and pending uploads; when the last owner leaves others
-- behind, the member who accepted first becomes an owner, so someone can
-- always manage it. A share that was never accepted leaves nothing to keep.
CREATE FUNCTION "folder_member_left"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."accepted_at" IS NULL OR OLD."role" <> 'owner' AND EXISTS (
		SELECT 1 FROM "folder_member"
		WHERE "folder_id" = OLD."folder_id" AND "accepted_at" IS NOT NULL AND "role" = 'owner'
	) THEN
		RETURN NULL;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM "folder_member"
		WHERE "folder_id" = OLD."folder_id" AND "accepted_at" IS NOT NULL
	) THEN
		DELETE FROM "folder" WHERE "id" = OLD."folder_id";
	ELSIF NOT EXISTS (
		SELECT 1 FROM "folder_member"
		WHERE "folder_id" = OLD."folder_id" AND "accepted_at" IS NOT NULL AND "role" = 'owner'
	) THEN
		UPDATE "folder_member" SET "role" = 'owner'
		WHERE ("folder_id", "account_id") = (
			SELECT "folder_id", "account_id" FROM "folder_member"
			WHERE "folder_id" = OLD."folder_id" AND "accepted_at" IS NOT NULL
			ORDER BY "accepted_at", "created_at", "account_id"
			LIMIT 1
		);
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "folder_member_left"
AFTER DELETE ON "folder_member"
FOR EACH ROW EXECUTE FUNCTION "folder_member_left"();
