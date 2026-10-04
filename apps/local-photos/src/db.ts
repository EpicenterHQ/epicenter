import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

export type SourceKind = 'google_takeout_full' | 'google_takeout_incremental';

export type ImportWarning = {
	code: string;
	path?: string;
	message: string;
};

export type ImportItemInput = {
	blobHash: string | null;
	contentHash: string;
	archivePath: string;
	originalName: string;
	sidecarPath: string | null;
	kind: 'media' | 'sidecar' | 'album_metadata' | 'unknown';
	rawSidecar: string | null;
};

export type BlobInput = {
	hash: string;
	bytes: number;
	mime: string | null;
	kind: 'image' | 'video';
};

export type ClaimInput = {
	assetHash: string;
	origin: 'filename' | 'takeout_json';
	takenAt: string | null;
	geoLat: number | null;
	geoLng: number | null;
	claimedName: string | null;
	raw: string | null;
};

export type ImportBatch = {
	id: string;
	fingerprint: string;
	sourceKind: SourceKind;
	sourceLocator: string;
	startedAt: string;
	finishedAt: string;
	filesSeen: number;
	blobsNew: number;
	sidecarsSeen: number;
	warnings: ImportWarning[];
	items: ImportItemInput[];
	blobs: BlobInput[];
	claims: ClaimInput[];
};

export type ImportSummary = {
	id: string;
	fingerprint: string;
	filesSeen: number;
	blobsNew: number;
	sidecarsSeen: number;
	warnings: ImportWarning[];
	wasAlreadyImported: boolean;
};

const INITIAL_SCHEMA = `
	CREATE TABLE blobs (
		hash TEXT PRIMARY KEY,
		bytes INTEGER NOT NULL,
		mime TEXT,
		stored_at TEXT NOT NULL,
		purged INTEGER NOT NULL DEFAULT 0 CHECK (purged IN (0, 1))
	);

	CREATE TABLE imports (
		id TEXT PRIMARY KEY,
		fingerprint TEXT NOT NULL UNIQUE,
		source_kind TEXT NOT NULL,
		source_locator TEXT NOT NULL,
		started_at TEXT NOT NULL,
		finished_at TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
		files_seen INTEGER NOT NULL,
		blobs_new INTEGER NOT NULL,
		sidecars_seen INTEGER NOT NULL,
		warnings TEXT NOT NULL
	);

	CREATE TABLE import_items (
		id INTEGER PRIMARY KEY,
		import_id TEXT NOT NULL REFERENCES imports(id),
		blob_hash TEXT REFERENCES blobs(hash),
		content_hash TEXT NOT NULL,
		archive_path TEXT NOT NULL,
		original_name TEXT NOT NULL,
		sidecar_path TEXT,
		kind TEXT NOT NULL CHECK (kind IN ('media', 'sidecar', 'album_metadata', 'unknown')),
		raw_sidecar TEXT,
		UNIQUE (import_id, archive_path)
	);

	CREATE TABLE assets (
		hash TEXT PRIMARY KEY REFERENCES blobs(hash),
		kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
		taken_at TEXT,
		geo_lat REAL,
		geo_lng REAL,
		width INTEGER,
		height INTEGER,
		live_pair_hash TEXT REFERENCES blobs(hash),
		first_seen_import TEXT NOT NULL REFERENCES imports(id),
		last_seen_import TEXT NOT NULL REFERENCES imports(id),
		resolved_at TEXT
	);

	CREATE TABLE claims (
		id INTEGER PRIMARY KEY,
		asset_hash TEXT NOT NULL REFERENCES assets(hash),
		import_id TEXT NOT NULL REFERENCES imports(id),
		source_kind TEXT NOT NULL,
		origin TEXT NOT NULL CHECK (origin IN ('filename', 'takeout_json')),
		taken_at TEXT,
		geo_lat REAL,
		geo_lng REAL,
		claimed_name TEXT,
		raw TEXT
	);
	CREATE UNIQUE INDEX claims_evidence_unique ON claims (
		asset_hash, import_id, origin, ifnull(claimed_name, ''), ifnull(raw, '')
	);

	CREATE TABLE tombstones (
		asset_hash TEXT PRIMARY KEY REFERENCES assets(hash),
		reason TEXT,
		created_at TEXT NOT NULL,
		blob_purged INTEGER NOT NULL DEFAULT 0 CHECK (blob_purged IN (0, 1))
	);

	CREATE INDEX import_items_blob_hash ON import_items(blob_hash);
	CREATE INDEX claims_asset_hash ON claims(asset_hash);
	CREATE INDEX imports_finished_at ON imports(finished_at);
`;

function migrate(db: Database): void {
	db.exec(
		'CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
	);
	const stored = db
		.query<{ value: string }, []>(
			"SELECT value FROM _meta WHERE key = 'schema_version'",
		)
		.get()?.value;
	const version = stored === undefined ? 0 : Number(stored);
	if (!Number.isInteger(version) || version < 0) {
		throw new Error(`Invalid Local Photos schema version: ${stored}`);
	}
	if (version > SCHEMA_VERSION) {
		throw new Error(
			`Archive schema ${version} is newer than this binary supports (${SCHEMA_VERSION}).`,
		);
	}
	if (version === SCHEMA_VERSION) return;

	db.transaction(() => {
		if (version < 1) db.exec(INITIAL_SCHEMA);
		db.query(
			`INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		).run(String(SCHEMA_VERSION));
	})();
}

export function openPhotosDb(
	path: string,
	{ readonly = false }: { readonly?: boolean } = {},
) {
	if (!readonly) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		chmodSync(dirname(path), 0o700);
	}
	const db = new Database(
		path,
		readonly ? { readonly: true } : { create: true },
	);
	db.exec('PRAGMA busy_timeout = 5000;');
	db.exec('PRAGMA foreign_keys = ON;');
	if (!readonly) {
		db.exec('PRAGMA journal_mode = WAL;');
		db.exec('PRAGMA synchronous = FULL;');
		chmodSync(path, 0o600);
		migrate(db);
	}

	function findImportByFingerprint(fingerprint: string): ImportSummary | null {
		const row = db
			.query<
				{
					id: string;
					fingerprint: string;
					files_seen: number;
					blobs_new: number;
					sidecars_seen: number;
					warnings: string;
				},
				[string]
			>(
				`SELECT id, fingerprint, files_seen, blobs_new, sidecars_seen, warnings
				 FROM imports WHERE fingerprint = ? AND status = 'complete'`,
			)
			.get(fingerprint);
		if (!row) return null;
		return {
			id: row.id,
			fingerprint: row.fingerprint,
			filesSeen: row.files_seen,
			blobsNew: row.blobs_new,
			sidecarsSeen: row.sidecars_seen,
			warnings: JSON.parse(row.warnings) as ImportWarning[],
			wasAlreadyImported: true,
		};
	}

	function recordImport(batch: ImportBatch): ImportSummary {
		const existing = findImportByFingerprint(batch.fingerprint);
		if (existing) return existing;

		db.transaction(() => {
			db.query(
				`INSERT INTO imports (
					id, fingerprint, source_kind, source_locator, started_at, finished_at,
					status, files_seen, blobs_new, sidecars_seen, warnings
				) VALUES (?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?)`,
			).run(
				batch.id,
				batch.fingerprint,
				batch.sourceKind,
				batch.sourceLocator,
				batch.startedAt,
				batch.finishedAt,
				batch.filesSeen,
				batch.blobsNew,
				batch.sidecarsSeen,
				JSON.stringify(batch.warnings),
			);

			const insertBlob = db.query(
				`INSERT INTO blobs (hash, bytes, mime, stored_at, purged)
				 VALUES (?, ?, ?, ?, 0)
				 ON CONFLICT(hash) DO UPDATE SET
				   bytes = excluded.bytes,
				   mime = coalesce(blobs.mime, excluded.mime),
				   purged = 0`,
			);
			const insertAsset = db.query(
				`INSERT INTO assets (
					hash, kind, first_seen_import, last_seen_import
				 ) VALUES (?, ?, ?, ?)
				 ON CONFLICT(hash) DO UPDATE SET last_seen_import = excluded.last_seen_import`,
			);
			for (const blob of batch.blobs) {
				insertBlob.run(blob.hash, blob.bytes, blob.mime, batch.finishedAt);
				insertAsset.run(blob.hash, blob.kind, batch.id, batch.id);
			}

			const insertItem = db.query(
				`INSERT INTO import_items (
					import_id, blob_hash, content_hash, archive_path, original_name,
					sidecar_path, kind, raw_sidecar
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const item of batch.items) {
				insertItem.run(
					batch.id,
					item.blobHash,
					item.contentHash,
					item.archivePath,
					item.originalName,
					item.sidecarPath,
					item.kind,
					item.rawSidecar,
				);
			}

			const insertClaim = db.query(
				`INSERT OR IGNORE INTO claims (
					asset_hash, import_id, source_kind, origin, taken_at, geo_lat,
					geo_lng, claimed_name, raw
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const claim of batch.claims) {
				insertClaim.run(
					claim.assetHash,
					batch.id,
					batch.sourceKind,
					claim.origin,
					claim.takenAt,
					claim.geoLat,
					claim.geoLng,
					claim.claimedName,
					claim.raw,
				);
			}
		})();

		return {
			id: batch.id,
			fingerprint: batch.fingerprint,
			filesSeen: batch.filesSeen,
			blobsNew: batch.blobsNew,
			sidecarsSeen: batch.sidecarsSeen,
			warnings: batch.warnings,
			wasAlreadyImported: false,
		};
	}

	function resolveAssets(resolvedAt = new Date().toISOString()): number {
		const result = db
			.query(`
			UPDATE assets SET
				taken_at = (
					SELECT c.taken_at FROM claims c
					JOIN imports i ON i.id = c.import_id
					WHERE c.asset_hash = assets.hash AND c.taken_at IS NOT NULL
					ORDER BY CASE c.origin WHEN 'takeout_json' THEN 0 ELSE 1 END,
					         i.finished_at DESC, c.id DESC
					LIMIT 1
				),
				geo_lat = (
					SELECT c.geo_lat FROM claims c
					JOIN imports i ON i.id = c.import_id
					WHERE c.asset_hash = assets.hash AND c.geo_lat IS NOT NULL
					ORDER BY CASE c.origin WHEN 'takeout_json' THEN 0 ELSE 1 END,
					         i.finished_at DESC, c.id DESC
					LIMIT 1
				),
				geo_lng = (
					SELECT c.geo_lng FROM claims c
					JOIN imports i ON i.id = c.import_id
					WHERE c.asset_hash = assets.hash AND c.geo_lng IS NOT NULL
					ORDER BY CASE c.origin WHEN 'takeout_json' THEN 0 ELSE 1 END,
					         i.finished_at DESC, c.id DESC
					LIMIT 1
				),
				resolved_at = ?;
		`)
			.run(resolvedAt);
		return result.changes;
	}

	return {
		findImportByFingerprint,
		recordImport,
		resolveAssets,
		close(): void {
			db.close();
		},
	};
}
