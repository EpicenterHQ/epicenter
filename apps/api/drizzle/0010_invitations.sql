-- A share is an invitation to an email, and members are equal (ADR-0820).
--
-- An invitation names an email, never an account, so making one says nothing
-- about whether anyone signs in with it; it waits until the person whose
-- verified email it names accepts it, whether they had an account when it
-- was made or signed up later. A `folder_member` row is now always someone
-- who accepted: each share still waiting moves to an invitation to its
-- person's email.
--
-- A member is a `member` or a `reader`, and no one owns a folder: `owner`
-- and `writer` become `member`. The earliest member no longer becomes an
-- owner when the last owner leaves; a folder still goes with its last member.
CREATE TABLE "folder_invitation" (
	"folder_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"shared_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "folder_invitation_folder_id_email_pk" PRIMARY KEY("folder_id","email"),
	CONSTRAINT "folder_invitation_role" CHECK ("folder_invitation"."role" in ('member', 'reader')),
	CONSTRAINT "folder_invitation_email_lower" CHECK ("folder_invitation"."email" = lower("folder_invitation"."email"))
);
--> statement-breakpoint
ALTER TABLE "folder_invitation" ADD CONSTRAINT "folder_invitation_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_invitation" ADD CONSTRAINT "folder_invitation_shared_by_user_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folder_invitation_email_idx" ON "folder_invitation" USING btree ("email");--> statement-breakpoint
-- The trigger is replaced before any row moves, so no change below promotes
-- or deletes anything by the old rule.
CREATE OR REPLACE FUNCTION "folder_member_left"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "folder_member" WHERE "folder_id" = OLD."folder_id"
	) THEN
		DELETE FROM "folder" WHERE "id" = OLD."folder_id";
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
INSERT INTO "folder_invitation" ("folder_id", "email", "role", "shared_by", "created_at")
SELECT m."folder_id", lower(u."email"),
	CASE m."role" WHEN 'reader' THEN 'reader' ELSE 'member' END,
	m."shared_by", m."created_at"
FROM "folder_member" m
JOIN "user" u ON u."id" = m."account_id"
WHERE m."accepted_at" IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- A waiting share's folder always has a member who accepted, so no folder
-- goes with these.
DELETE FROM "folder_member" WHERE "accepted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "folder_member" ALTER COLUMN "accepted_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "folder_member" ALTER COLUMN "accepted_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "folder_member" DROP CONSTRAINT "folder_member_role";--> statement-breakpoint
UPDATE "folder_member" SET "role" = 'member' WHERE "role" IN ('owner', 'writer');--> statement-breakpoint
ALTER TABLE "folder_member" ADD CONSTRAINT "folder_member_role" CHECK ("folder_member"."role" in ('member', 'reader'));
