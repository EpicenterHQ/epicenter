import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { HostedBlobStore } from './routes/authority-blobs.js';

type BlobRow = {
	size: number;
	content_type: string;
	etag: string;
	modified: string;
};

/** A committed row is the complete published object; no temporary file is public. */
export function openLocalBlobStore(path: string) {
	const database = new Database(path, { create: true });
	database.exec('PRAGMA journal_mode = WAL');
	database.exec('PRAGMA busy_timeout = 5000');
	database.exec(`CREATE TABLE IF NOT EXISTS blobs (
		key TEXT PRIMARY KEY,
		bytes BLOB NOT NULL,
		content_type TEXT NOT NULL,
		etag TEXT NOT NULL,
		modified TEXT NOT NULL
	)`);
	const insert = database.prepare(
		'INSERT INTO blobs (key, bytes, content_type, etag, modified) VALUES (?, ?, ?, ?, ?)',
	);
	const select = database.prepare<BlobRow, [string]>(
		'SELECT length(bytes) AS size, content_type, etag, modified FROM blobs WHERE key = ?',
	);
	const slice = database.prepare<
		{ bytes: Uint8Array },
		[number, number, string]
	>('SELECT substr(bytes, ?, ?) AS bytes FROM blobs WHERE key = ?');
	const remove = database.prepare('DELETE FROM blobs WHERE key = ?');
	const store: HostedBlobStore = {
		async put(key, body, signal) {
			signal?.throwIfAborted();
			const bytes = new Uint8Array(await body.arrayBuffer());
			signal?.throwIfAborted();
			const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
			try {
				insert.run(
					key,
					bytes,
					body.type || 'application/octet-stream',
					etag,
					new Date().toUTCString(),
				);
				return 'created';
			} catch (error) {
				if (
					error instanceof Error &&
					'code' in error &&
					error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
				)
					return 'conflict';
				throw error;
			}
		},
		async head(key, signal) {
			signal?.throwIfAborted();
			const row = select.get(key);
			return row
				? {
						size: row.size,
						contentType: row.content_type,
						etag: row.etag,
						lastModified: row.modified,
					}
				: null;
		},
		async read(key, start, end, _etag, signal) {
			signal?.throwIfAborted();
			return slice.get(start + 1, end - start + 1, key)?.bytes ?? null;
		},
		async delete(key, signal) {
			signal?.throwIfAborted();
			remove.run(key);
		},
	};
	return { store, close: () => database.close() };
}
