-- Every account has exactly one personal namespace, made in the same
-- transaction as the account (ADR-0547). The trigger runs inside the statement
-- that inserts the account, so no sign-in path can create an account without
-- one. The id is Epicenter's own: twelve characters of lowercase a-z and 0-9.
CREATE FUNCTION "new_namespace_id"() RETURNS text
LANGUAGE sql VOLATILE AS $$
	SELECT string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + floor(random() * 36)::int, 1), '')
	FROM generate_series(1, 12)
$$;
--> statement-breakpoint
CREATE FUNCTION "create_personal_namespace"(account_id text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	namespace_id text;
BEGIN
	LOOP
		namespace_id := "new_namespace_id"();
		BEGIN
			INSERT INTO "namespace" ("id", "title", "personal_account_id")
			VALUES (namespace_id, 'Personal', account_id);
			EXIT;
		EXCEPTION WHEN unique_violation THEN
			-- The account already has its namespace: nothing to do.
			IF EXISTS (SELECT 1 FROM "namespace" WHERE "personal_account_id" = account_id) THEN
				RETURN NULL;
			END IF;
			-- Otherwise the random id collided; draw again.
		END;
	END LOOP;
	INSERT INTO "namespace_member" ("namespace_id", "account_id", "role")
	VALUES (namespace_id, account_id, 'owner');
	RETURN namespace_id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "user_personal_namespace"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "create_personal_namespace"(NEW."id");
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_personal_namespace"
AFTER INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION "user_personal_namespace"();
--> statement-breakpoint
-- Accounts that predate namespaces get theirs now.
SELECT "create_personal_namespace"("id") FROM "user"
WHERE NOT EXISTS (SELECT 1 FROM "namespace" WHERE "personal_account_id" = "user"."id");
