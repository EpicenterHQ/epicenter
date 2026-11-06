-- A folder's history is a log of versions (ADR-0824), and marks name its
-- moments (ADR-0826). `epicenter_commit` at the end is a commit: one
-- statement, so one round trip through Hyperdrive.
CREATE TABLE "blob" (
	"folder_id" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"state" text NOT NULL,
	"inline" "bytea",
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "blob_folder_id_sha256_pk" PRIMARY KEY("folder_id","sha256"),
	CONSTRAINT "blob_sha256_format" CHECK ("blob"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "blob_state" CHECK ("blob"."state" in ('pending', 'kept', 'purged')),
	CONSTRAINT "blob_purged_inline" CHECK ("blob"."state" <> 'purged' or "blob"."inline" is null)
);
--> statement-breakpoint
CREATE TABLE "change" (
	"folder_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"account_id" text,
	"author_text" text NOT NULL,
	"via" text NOT NULL,
	"message" text,
	"digest" text NOT NULL,
	CONSTRAINT "change_folder_id_seq_pk" PRIMARY KEY("folder_id","seq")
);
--> statement-breakpoint
CREATE TABLE "change_file" (
	"folder_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"path" text COLLATE "C" NOT NULL,
	"version" text,
	"size" bigint,
	CONSTRAINT "change_file_folder_id_path_seq_pk" PRIMARY KEY("folder_id","path","seq")
);
--> statement-breakpoint
CREATE TABLE "file" (
	"folder_id" text NOT NULL,
	"path" text COLLATE "C" NOT NULL,
	"folded" text COLLATE "C" NOT NULL,
	"version" text NOT NULL,
	"size" bigint NOT NULL,
	"seq" bigint NOT NULL,
	CONSTRAINT "file_folder_id_path_pk" PRIMARY KEY("folder_id","path"),
	CONSTRAINT "file_folded_unique" UNIQUE("folder_id","folded")
);
--> statement-breakpoint
CREATE TABLE "mark" (
	"folder_id" text NOT NULL,
	"name" text NOT NULL,
	"seq" bigint NOT NULL,
	"account_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mark_folder_id_name_pk" PRIMARY KEY("folder_id","name")
);
--> statement-breakpoint
ALTER TABLE "folder" ADD COLUMN "seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "folder" ADD COLUMN "epoch" text DEFAULT substr(md5(gen_random_uuid()::text), 1, 12) NOT NULL;--> statement-breakpoint
ALTER TABLE "folder" ADD COLUMN "importing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "blob" ADD CONSTRAINT "blob_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change" ADD CONSTRAINT "change_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_file" ADD CONSTRAINT "change_file_folder_id_seq_change_folder_id_seq_fk" FOREIGN KEY ("folder_id","seq") REFERENCES "public"."change"("folder_id","seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_file" ADD CONSTRAINT "change_file_folder_id_version_blob_folder_id_sha256_fk" FOREIGN KEY ("folder_id","version") REFERENCES "public"."blob"("folder_id","sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_folder_id_version_blob_folder_id_sha256_fk" FOREIGN KEY ("folder_id","version") REFERENCES "public"."blob"("folder_id","sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark" ADD CONSTRAINT "mark_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mark" ADD CONSTRAINT "mark_folder_id_seq_change_folder_id_seq_fk" FOREIGN KEY ("folder_id","seq") REFERENCES "public"."change"("folder_id","seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_pending_idx" ON "blob" USING btree ("uploaded_at") WHERE "blob"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "change_at_idx" ON "change" USING btree ("folder_id","at");--> statement-breakpoint
CREATE INDEX "change_file_seq_idx" ON "change_file" USING btree ("folder_id","seq");--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_epoch_format" CHECK ("folder"."epoch" ~ '^[a-z0-9]{1,32}$');
--> statement-breakpoint
-- One change to `p_folder`, or why none landed (ADR-0824). `p_files` is a
-- JSON array of `{ path, folded, expect, version, size?, inline? }`:
-- `expect` is the version the writer read at the path (null: nothing),
-- `version` the one it writes (null: a deletion), `folded` the path as a
-- disk that ignores case compares it, and `inline` the bytes in base64 when
-- they come with the change (`size` with them). The folder's row is locked,
-- so changes are numbered densely in commit order. It answers one of:
--   { seq, epoch, versions }  landed (or changed nothing), each path's version;
--   { moved: [{ path, now }] } every path that holds something else, nothing landed;
--   { missing: [version] }     versions named that the folder holds no bytes for;
--   { refused: { path, held, reason } }  'case', 'folder' (a folder is there),
--                              or 'file' (a file is on the way), nothing landed;
--   { error: 'no_folder' | 'not_importing' }.
-- `p_imported` (`{ author, at, message }`, `at` in milliseconds) keeps an
-- imported commit's author, time, and message (ADR-0826), only while the
-- folder is importing.
CREATE OR REPLACE FUNCTION "epicenter_commit"(
	p_folder text,
	p_account text,
	p_via text,
	p_files jsonb,
	p_imported jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
	v_seq bigint;
	v_epoch text;
	v_importing boolean;
	v_found jsonb;
	v_next bigint;
	v_at timestamptz;
	v_author text;
	v_message text;
	v_prev text;
	v_files text;
	v_refusal text;
	w record;
	v_hit text;
	v_segments text[];
	v_folded text[];
	v_dir text;
	v_fdir text;
BEGIN
	SELECT "seq", "epoch", "importing" INTO v_seq, v_epoch, v_importing
	FROM "folder" WHERE "id" = p_folder FOR UPDATE;
	IF NOT FOUND THEN
		RETURN jsonb_build_object('error', 'no_folder');
	END IF;
	IF p_imported IS NOT NULL AND NOT v_importing THEN
		RETURN jsonb_build_object('error', 'not_importing');
	END IF;

	-- Every path that holds something other than its writer expects.
	SELECT jsonb_agg(jsonb_build_object('path', a.path, 'now', f."version") ORDER BY a.path COLLATE "C")
	INTO v_found
	FROM jsonb_to_recordset(p_files) AS a(path text, expect text)
	LEFT JOIN "file" f ON f."folder_id" = p_folder AND f."path" = a.path COLLATE "C"
	WHERE f."version" IS DISTINCT FROM a.expect;
	IF v_found IS NOT NULL THEN
		RETURN jsonb_build_object('moved', v_found);
	END IF;

	-- A version named without its bytes must be one the folder holds.
	SELECT jsonb_agg(DISTINCT a.version) INTO v_found
	FROM jsonb_to_recordset(p_files) AS a(version text, expect text, inline text)
	WHERE a.version IS NOT NULL AND a.version IS DISTINCT FROM a.expect
		AND a.inline IS NULL
		AND NOT EXISTS (
			SELECT 1 FROM "blob" b
			WHERE b."folder_id" = p_folder AND b."sha256" = a.version AND b."state" <> 'purged'
		);
	IF v_found IS NOT NULL THEN
		RETURN jsonb_build_object('missing', v_found);
	END IF;

	SELECT jsonb_object_agg(a.path, a.version) INTO v_found
	FROM jsonb_to_recordset(p_files) AS a(path text, version text);

	-- Writing what a path holds changes nothing: no change is made.
	IF NOT EXISTS (
		SELECT 1 FROM jsonb_to_recordset(p_files) AS a(version text, expect text)
		WHERE a.version IS DISTINCT FROM a.expect
	) THEN
		RETURN jsonb_build_object('seq', v_seq, 'epoch', v_epoch, 'versions', coalesce(v_found, '{}'));
	END IF;

	v_next := v_seq + 1;
	BEGIN
		INSERT INTO "blob" ("folder_id", "sha256", "size", "state", "inline")
		SELECT DISTINCT ON (a.version) p_folder, a.version, a.size, 'kept', decode(a.inline, 'base64')
		FROM jsonb_to_recordset(p_files) AS a(version text, expect text, size bigint, inline text)
		WHERE a.inline IS NOT NULL AND a.version IS DISTINCT FROM a.expect
		ORDER BY a.version
		ON CONFLICT ("folder_id", "sha256") DO UPDATE
			SET "state" = 'kept', "inline" = coalesce("blob"."inline", excluded."inline");

		UPDATE "blob" SET "state" = 'kept'
		WHERE "folder_id" = p_folder AND "state" = 'pending' AND "sha256" IN (
			SELECT a.version FROM jsonb_to_recordset(p_files) AS a(version text, expect text)
			WHERE a.version IS NOT NULL AND a.version IS DISTINCT FROM a.expect
		);

		DELETE FROM "file" f
		USING jsonb_to_recordset(p_files) AS a(path text, version text, expect text)
		WHERE f."folder_id" = p_folder AND f."path" = a.path COLLATE "C"
			AND a.version IS NULL AND a.expect IS NOT NULL;

		FOR w IN
			SELECT a.path, a.folded, a.version, a.expect, b."size"
			FROM jsonb_to_recordset(p_files) AS a(path text, folded text, version text, expect text)
			JOIN "blob" b ON b."folder_id" = p_folder AND b."sha256" = a.version
			WHERE a.version IS DISTINCT FROM a.expect
			ORDER BY a.path COLLATE "C"
		LOOP
			IF w.expect IS NULL THEN
				-- Another file whose name differs only in case.
				SELECT "path" INTO v_hit FROM "file"
				WHERE "folder_id" = p_folder AND "folded" = w.folded COLLATE "C";
				IF FOUND THEN
					RAISE EXCEPTION USING ERRCODE = 'EP409', MESSAGE =
						jsonb_build_object('path', w.path, 'held', v_hit, 'reason', 'case')::text;
				END IF;
				-- A folder at the path, in any case.
				SELECT "path" INTO v_hit FROM "file"
				WHERE "folder_id" = p_folder
					AND "folded" >= (w.folded || '/') COLLATE "C"
					AND "folded" < (w.folded || '0') COLLATE "C"
				LIMIT 1;
				IF FOUND THEN
					RAISE EXCEPTION USING ERRCODE = 'EP409', MESSAGE = jsonb_build_object(
						'path', w.path,
						'held', v_hit,
						'reason', CASE WHEN starts_with(v_hit, w.path || '/') THEN 'folder' ELSE 'case' END
					)::text;
				END IF;
				-- Each folder on the way: no file there, and spelled as the folder holds it.
				v_segments := string_to_array(w.path, '/');
				v_folded := string_to_array(w.folded, '/');
				FOR i IN 1 .. coalesce(array_length(v_segments, 1), 1) - 1 LOOP
					v_dir := array_to_string(v_segments[1:i], '/');
					v_fdir := array_to_string(v_folded[1:i], '/');
					SELECT "path" INTO v_hit FROM "file"
					WHERE "folder_id" = p_folder AND "folded" = v_fdir COLLATE "C";
					IF FOUND THEN
						RAISE EXCEPTION USING ERRCODE = 'EP409', MESSAGE = jsonb_build_object(
							'path', v_dir,
							'held', v_hit,
							'reason', CASE WHEN v_hit = v_dir THEN 'file' ELSE 'case' END
						)::text;
					END IF;
					SELECT "path" INTO v_hit FROM "file"
					WHERE "folder_id" = p_folder
						AND "folded" >= (v_fdir || '/') COLLATE "C"
						AND "folded" < (v_fdir || '0') COLLATE "C"
						AND NOT starts_with("path", v_dir || '/')
					LIMIT 1;
					IF FOUND THEN
						RAISE EXCEPTION USING ERRCODE = 'EP409', MESSAGE = jsonb_build_object(
							'path', v_dir,
							'held', array_to_string((string_to_array(v_hit, '/'))[1:i], '/'),
							'reason', 'case'
						)::text;
					END IF;
				END LOOP;
			END IF;
			INSERT INTO "file" ("folder_id", "path", "folded", "version", "size", "seq")
			VALUES (p_folder, w.path, w.folded, w.version, w.size, v_next)
			ON CONFLICT ("folder_id", "path") DO UPDATE
				SET "version" = excluded."version", "size" = excluded."size", "seq" = excluded."seq";
		END LOOP;

		IF p_imported IS NULL THEN
			v_at := date_trunc('milliseconds', clock_timestamp());
			SELECT coalesce(u."name", '') || ' <' || coalesce(u."email", '') || '>' INTO v_author
			FROM "user" u WHERE u."id" = p_account;
			v_author := coalesce(v_author, 'Unknown <>');
			v_message := NULL;
		ELSE
			v_at := to_timestamp(((p_imported->>'at')::numeric) / 1000);
			v_author := p_imported->>'author';
			v_message := p_imported->>'message';
		END IF;

		SELECT string_agg(
			'file ' || to_jsonb(a.path)::text || ' ' || coalesce(a.version, '-') || ' '
				|| coalesce(b."size"::text, '-') || E'\n',
			'' ORDER BY a.path COLLATE "C")
		INTO v_files
		FROM jsonb_to_recordset(p_files) AS a(path text, version text, expect text)
		LEFT JOIN "blob" b ON b."folder_id" = p_folder AND b."sha256" = a.version
		WHERE a.version IS DISTINCT FROM a.expect;

		SELECT "digest" INTO v_prev FROM "change" WHERE "folder_id" = p_folder AND "seq" = v_seq;

		INSERT INTO "change" ("folder_id", "seq", "at", "account_id", "author_text", "via", "message", "digest")
		VALUES (
			p_folder, v_next, v_at, p_account, v_author, p_via, v_message,
			encode(sha256(convert_to(
				coalesce(v_prev, '')
				|| 'epicenter change v1' || E'\n'
				|| 'folder ' || p_folder || E'\n'
				|| 'seq ' || v_next || E'\n'
				|| 'at ' || round(extract(epoch FROM v_at) * 1000)::bigint || E'\n'
				|| 'account ' || coalesce(p_account, '') || E'\n'
				|| 'author ' || to_jsonb(v_author)::text || E'\n'
				|| 'via ' || to_jsonb(p_via)::text || E'\n'
				|| 'message ' || coalesce(to_jsonb(v_message)::text, 'null') || E'\n'
				|| coalesce(v_files, ''),
				'UTF8')), 'hex')
		);

		INSERT INTO "change_file" ("folder_id", "seq", "path", "version", "size")
		SELECT p_folder, v_next, a.path, a.version, b."size"
		FROM jsonb_to_recordset(p_files) AS a(path text, version text, expect text)
		LEFT JOIN "blob" b ON b."folder_id" = p_folder AND b."sha256" = a.version
		WHERE a.version IS DISTINCT FROM a.expect;

		UPDATE "folder" SET "seq" = v_next WHERE "id" = p_folder;
	EXCEPTION WHEN SQLSTATE 'EP409' THEN
		GET STACKED DIAGNOSTICS v_refusal = MESSAGE_TEXT;
		RETURN jsonb_build_object('refused', v_refusal::jsonb);
	END;
	RETURN jsonb_build_object('seq', v_next, 'epoch', v_epoch, 'versions', coalesce(v_found, '{}'));
END;
$$;
