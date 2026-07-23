import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	SCALAR_SYNC_V1_LIMITS,
	type ValidatedLimits,
} from '../protocol/v1/index.js';
import {
	type BlobByteSource,
	type BunBlobRead,
	createBunBlobFileStore,
} from '../store/replica/bun-blob-files.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
} from '../store/replica/index.js';
import { createEpicenterRuntime } from './epicenter.js';
import type { AuthorityCarrier, RuntimeBackoff } from './supervisor.js';

export type OpenBunEpicenterOptions =
	| {
			directory: string;
			database?: never;
			limits?: ValidatedLimits;
			carrier?: AuthorityCarrier<BunBlobRead> | null;
			intervalMs?: number;
			backoff?: RuntimeBackoff;
	  }
	| {
			database: string;
			directory?: never;
			limits?: ValidatedLimits;
			carrier?: AuthorityCarrier<BunBlobRead> | null;
			intervalMs?: number;
			backoff?: RuntimeBackoff;
	  };

function replicaId(): string {
	const bytes = new Uint8Array(18);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
}

export async function openBunEpicenter(options: OpenBunEpicenterOptions) {
	const path =
		options.database !== undefined
			? options.database
			: await mkdir(options.directory, { recursive: true }).then(() =>
					join(options.directory, 'epicenter.sqlite3'),
				);
	const storageRoot =
		options.directory !== undefined ? options.directory : dirname(path);
	await mkdir(storageRoot, { recursive: true });
	const raw = new Database(path, { create: true, strict: true });
	try {
		const database = createBunSqliteAdapter(raw);
		const store = openReplicaStore({
			database,
			limits: options.limits ?? SCALAR_SYNC_V1_LIMITS,
			initialize: { replicaId: replicaId() },
		});
		const blobs = createReplicaBlobStore(
			database,
			createBunBlobFileStore(storageRoot),
		);
		await blobs.reopenSweep();
		return createEpicenterRuntime<BlobByteSource, BunBlobRead>({
			store,
			blobs,
			carrier: options.carrier ?? null,
			...(options.intervalMs === undefined
				? {}
				: { intervalMs: options.intervalMs }),
			...(options.backoff === undefined ? {} : { backoff: options.backoff }),
			disposeOwned: () => raw.close(),
		});
	} catch (cause) {
		raw.close();
		throw cause;
	}
}
