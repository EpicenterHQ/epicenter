/**
 * Test-only SQLite reference stores for the record lane-machine conformance
 * suite (ADR-0177, ADR-0163).
 *
 * These schemas are oracles, not product stores: they give the maintained
 * conformance cases a concrete ADR-0177-shaped fixture to execute against
 * before any production store exists. W1B binds the replica case subset to the
 * production Bun adapter; W2 binds the authority subset; W3 binds the
 * document/blob subset. Nothing here is exported from the package.
 *
 * The replica row is the whole per-address crash-state machine: identity
 * triple, confirmed lane, sealed lane, pending lane, parked overlay, and the
 * small document and blob publication watermarks. `record_id` interns the triple
 * for the byte-heavy sibling relations. Lane shapes are row-local CHECK
 * disjunctions with explicit IS NOT NULL guards on every occupied branch (the
 * disposable probe proved that `confirmed_sequence >= 1` alone admits a NULL
 * sequence through three-valued logic). Parking is legal only for a patch,
 * with code-specific measurement guards. There are no foreign-key cascades:
 * the tombstone and erase transactions own their cleanup visibly.
 *
 * The replica `meta` row persists the sealed submission's exact canonical
 * request bytes and hash (ADR-0163): retry sends those bytes, so a
 * same-number different-hash fork can never be manufactured by re-encoding.
 *
 * Crash simulation is file-backed: `crashDuringTransaction` executes a
 * statement prefix inside an open transaction, copies the database file and
 * its hot rollback journal as they exist at that instant, abandons the
 * original transaction, and reopens the copy, so SQLite's crash recovery
 * (journal rollback on open) is what restores the persistent state.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalize } from '../../protocol/v1/index.js';

export const REPLICA_DDL = `
CREATE TABLE meta (
  singleton              INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_version         INTEGER NOT NULL,
  replica_id             TEXT    NOT NULL,
  attached_deployment    TEXT,
  attached_principal     TEXT,
  authority_lifetime     TEXT,
  erased_authority_lifetime TEXT,
  after_sequence         INTEGER NOT NULL DEFAULT 0 CHECK (after_sequence >= 0),
  sealed_submission      INTEGER,               -- NULL = nothing in flight
  sealed_request         TEXT,                  -- exact canonical request bytes
  sealed_request_hash    TEXT,
  next_submission        INTEGER NOT NULL DEFAULT 1,
  CHECK ((attached_deployment IS NULL) = (attached_principal IS NULL)),
  -- The three sealed columns occupy together or not at all.
  CHECK ((sealed_submission IS NULL) = (sealed_request IS NULL)),
  CHECK ((sealed_submission IS NULL) = (sealed_request_hash IS NULL))
) STRICT;

CREATE TABLE records (
  record_id           INTEGER PRIMARY KEY,      -- rowid; stable; interning key
  namespace           TEXT NOT NULL,
  collection          TEXT NOT NULL,
  record_key          TEXT NOT NULL,

  -- confirmed lane: what the authority last said (NULL state = never learned)
  confirmed_state     TEXT,
  confirmed_payload   TEXT,
  confirmed_sequence  INTEGER,

  -- sealed lane: immutable in-flight desire
  sealed_op           TEXT,
  sealed_args         TEXT,

  -- pending lane: mutable compacted desire
  pending_op          TEXT,
  pending_args        TEXT,

  -- parked overlay: the refused desire kept whole, visible, non-retrying
  parked_op           TEXT,
  parked_args         TEXT,
  parked_code         TEXT,
  parked_measured     INTEGER,
  parked_limit        INTEGER,

  -- publication watermarks (small; bytes live elsewhere). Obligations are
  -- derived, never stored: a document is owed while the local revision runs
  -- ahead of the authority-accepted revision, and a blob is owed while its
  -- local digest lacks a matching accepted digest.
  document_revision           INTEGER NOT NULL DEFAULT 0
    CHECK (document_revision >= 0),
  document_accepted_revision  INTEGER NOT NULL DEFAULT 0
    CHECK (document_accepted_revision >= 0),
  document_refused_revision   INTEGER,
  document_refused_bytes      INTEGER,
  document_refused_structs    INTEGER,
  blob_sha256                 TEXT,
  blob_accepted_sha256        TEXT,

  -- Lane shapes. SQLite CHECKs pass on NULL, so every occupied branch carries
  -- explicit IS NOT NULL guards; a branch is definitively false, never NULL.
  CHECK ((confirmed_state IS NULL AND confirmed_payload IS NULL
            AND confirmed_sequence IS NULL)
      OR (confirmed_state = 'live' AND confirmed_payload IS NOT NULL
            AND json_valid(confirmed_payload)
            AND confirmed_sequence IS NOT NULL AND confirmed_sequence >= 1)
      OR (confirmed_state IN ('tombstone','unset') AND confirmed_payload IS NULL
            AND confirmed_sequence IS NOT NULL AND confirmed_sequence >= 1)),
  CHECK ((sealed_op IS NULL AND sealed_args IS NULL)
      OR (sealed_op IN ('patch','replace') AND sealed_args IS NOT NULL
            AND json_valid(sealed_args))
      OR (sealed_op IN ('tombstone','unset') AND sealed_args IS NULL)),
  CHECK ((pending_op IS NULL AND pending_args IS NULL)
      OR (pending_op IN ('patch','replace') AND pending_args IS NOT NULL
            AND json_valid(pending_args))
      OR (pending_op IN ('tombstone','unset') AND pending_args IS NULL)),
  -- Only a patch can park (ADR-0163), and its diagnostics are code-specific:
  -- fact-too-large carries both measurements, patch-base-not-object neither.
  CHECK ((parked_op IS NULL AND parked_args IS NULL AND parked_code IS NULL
            AND parked_measured IS NULL AND parked_limit IS NULL)
      OR (parked_op = 'patch' AND parked_args IS NOT NULL
            AND json_valid(parked_args)
            AND ((parked_code = 'fact-too-large'
                    AND parked_measured IS NOT NULL AND parked_limit IS NOT NULL)
              OR (parked_code = 'patch-base-not-object'
                    AND parked_measured IS NULL AND parked_limit IS NULL)))),
  -- parked excludes newer desire: a later write consumes the parked lane
  CHECK (parked_op IS NULL
      OR (pending_op IS NULL AND sealed_op IS NULL)),
  CHECK (document_accepted_revision <= document_revision),
  CHECK ((document_refused_revision IS NULL AND document_refused_bytes IS NULL
            AND document_refused_structs IS NULL)
      OR (document_refused_revision = document_revision
            AND document_revision > document_accepted_revision
            AND document_refused_bytes IS NOT NULL
            AND document_refused_structs IS NOT NULL)),
  CHECK (blob_sha256 IS NULL OR length(blob_sha256) = 64),
  CHECK (blob_accepted_sha256 IS NULL OR
    (blob_sha256 IS NOT NULL AND blob_accepted_sha256 = blob_sha256)),
  -- a row exists only while something is true at the address
  CHECK (confirmed_state IS NOT NULL OR pending_op IS NOT NULL
         OR sealed_op IS NOT NULL OR parked_op IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX records_address
  ON records(namespace, collection, record_key);
CREATE INDEX records_pending ON records(namespace, collection, record_key)
  WHERE pending_op IS NOT NULL;
CREATE INDEX records_sealed  ON records(namespace, collection, record_key)
  WHERE sealed_op IS NOT NULL;
CREATE INDEX records_document_owed ON records(namespace, collection, record_key)
  WHERE document_revision > document_accepted_revision;
CREATE INDEX records_blob_owed ON records(namespace, collection, record_key)
  WHERE blob_sha256 IS NOT NULL AND
    (blob_accepted_sha256 IS NULL OR blob_accepted_sha256 != blob_sha256);

CREATE TABLE record_documents (        -- bounded baseline-plus-tail chain
  chain_id   INTEGER PRIMARY KEY,
  record_id  INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('baseline','update')),
  bytes      BLOB NOT NULL,
  UNIQUE (record_id, seq)
) STRICT;

`;

export const AUTHORITY_DDL = `
CREATE TABLE meta (
  singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_version     INTEGER NOT NULL,
  authority_lifetime TEXT    NOT NULL,
  next_sequence      INTEGER NOT NULL CHECK (next_sequence >= 1)
) STRICT;

CREATE TABLE records (
  record_id   INTEGER PRIMARY KEY,
  namespace   TEXT NOT NULL,
  collection  TEXT NOT NULL,
  record_key  TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('live','tombstone','unset')),
  payload     TEXT,
  sequence    INTEGER NOT NULL CHECK (sequence >= 1),
  blob_sha256 TEXT CHECK (blob_sha256 IS NULL OR length(blob_sha256) = 64),
  CHECK ((state = 'live') = (payload IS NOT NULL)),
  CHECK (payload IS NULL OR json_valid(payload))
) STRICT;

CREATE UNIQUE INDEX records_address  ON records(namespace, collection, record_key);
CREATE UNIQUE INDEX records_sequence ON records(sequence);

CREATE TABLE replica_witness (
  replica_id        TEXT PRIMARY KEY
    CHECK (length(replica_id) = 24 AND replica_id NOT GLOB '*[^a-z0-9]*'),
  submission_number INTEGER NOT NULL CHECK (submission_number >= 1),
  request_hash      TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  parked            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parked))
) STRICT;

CREATE TABLE record_documents (
  chain_id  INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL,
  seq       INTEGER NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('baseline','update')),
  bytes     BLOB NOT NULL,
  UNIQUE (record_id, seq)
) STRICT;
-- same explicit-deletion rule as the replica: the tombstone fold deletes
-- this record's chain rows in its own transaction; no FK cascades.
`;

export type Statement = { sql: string; params?: SQLQueryBindings[] };

let crashCounter = 0;

/**
 * One file-backed reference database with transactional crash simulation.
 *
 * Ownership of the on-disk fixture is explicit: `create` makes a fresh
 * temporary directory and the returned instance owns it; `reopen` transfers
 * that ownership to the reopened handle; crashed copies opened via `open` are
 * never owners and just `close`. The owner's `dispose` removes the whole
 * directory (database file, journals, and every crashed copy) after tests.
 */
export class ReferenceDb {
	private constructor(
		readonly path: string,
		readonly db: Database,
		private ownedDir: string | null,
	) {}

	static create(kind: 'replica' | 'authority'): ReferenceDb {
		const dir = mkdtempSync(join(tmpdir(), 'epicenter-conformance-'));
		const path = join(dir, `${kind}.sqlite`);
		const db = new Database(path, { create: true, strict: true });
		db.run('PRAGMA journal_mode = DELETE');
		db.run(kind === 'replica' ? REPLICA_DDL : AUTHORITY_DDL);
		return new ReferenceDb(path, db, dir);
	}

	static open(path: string): ReferenceDb {
		return new ReferenceDb(path, new Database(path, { strict: true }), null);
	}

	run(statement: Statement): void {
		this.db.query(statement.sql).run(...(statement.params ?? []));
	}

	all<T>(sql: string, params: SQLQueryBindings[] = []): T[] {
		return this.db.query(sql).all(...params) as T[];
	}

	get<T>(sql: string, params: SQLQueryBindings[] = []): T | null {
		return this.db.query(sql).get(...params) as T | null;
	}

	/** Apply a transition as one atomic transaction. */
	applyTransaction(statements: readonly Statement[]): void {
		this.db.run('BEGIN IMMEDIATE');
		try {
			for (const statement of statements) this.run(statement);
			this.db.run('COMMIT');
		} catch (error) {
			this.db.run('ROLLBACK');
			throw error;
		}
	}

	/**
	 * Execute the first `boundary` statements of a transition inside an open
	 * transaction, then simulate a process kill: copy the database file and its
	 * hot rollback journal exactly as they exist mid-transaction, abandon the
	 * original transaction, and reopen the copy. SQLite's own recovery (rolling
	 * the hot journal back on open) is what the caller then observes.
	 */
	crashDuringTransaction(
		statements: readonly Statement[],
		boundary: number,
	): ReferenceDb {
		this.db.run('BEGIN IMMEDIATE');
		for (let index = 0; index < boundary; index += 1) {
			const statement = statements[index];
			if (statement === undefined) throw new Error('boundary out of range');
			this.run(statement);
		}
		crashCounter += 1;
		const crashedPath = `${this.path}.crash-${crashCounter}`;
		copyFileSync(this.path, crashedPath);
		const journal = `${this.path}-journal`;
		if (existsSync(journal)) copyFileSync(journal, `${crashedPath}-journal`);
		this.db.run('ROLLBACK');
		return ReferenceDb.open(crashedPath);
	}

	/**
	 * Close and reopen the same file, as a clean process restart would.
	 * Directory ownership moves to the reopened handle, so the fixture stays
	 * disposable through any number of restarts.
	 */
	reopen(): ReferenceDb {
		this.db.close();
		const reopened = new ReferenceDb(
			this.path,
			new Database(this.path, { strict: true }),
			this.ownedDir,
		);
		this.ownedDir = null;
		return reopened;
	}

	/**
	 * A canonical serialization of the logical state: every relation ordered by
	 * its logical identity, with the private interning `record_id` projected
	 * away (sibling rows are joined back to their owning triple).
	 */
	private hasTable(name: string): boolean {
		return (
			this.get<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
				[name],
			) !== null
		);
	}

	logicalState(): string {
		const meta = this.get<Record<string, unknown>>(
			'SELECT * FROM meta WHERE singleton = 1',
		);
		const records = this.all<Record<string, unknown>>(
			'SELECT * FROM records ORDER BY namespace, collection, record_key',
		).map(({ record_id: _recordId, ...logical }) => logical);
		const documents = this.all<Record<string, unknown>>(
			`SELECT r.namespace, r.collection, r.record_key, d.seq, d.kind, hex(d.bytes) AS bytes
			 FROM record_documents d JOIN records r ON r.record_id = d.record_id
			 ORDER BY r.namespace, r.collection, r.record_key, d.seq`,
		);
		const witness = this.hasTable('replica_witness')
			? this.all<Record<string, unknown>>(
					'SELECT * FROM replica_witness ORDER BY replica_id',
				)
			: [];
		return canonicalize(
			JSON.parse(JSON.stringify({ meta, records, documents, witness })),
		);
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Owning disposal: close the handle and delete the fixture's temporary
	 * directory, taking the database file, its journals, and every crashed
	 * copy with it. Only the current owner (the created instance, or the
	 * latest reopen of it) removes anything; disposing a non-owner is a close.
	 */
	dispose(): void {
		this.db.close();
		if (this.ownedDir !== null) {
			rmSync(this.ownedDir, { recursive: true, force: true });
			this.ownedDir = null;
		}
	}
}
