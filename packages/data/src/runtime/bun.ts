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
	type ReplicaOwner,
} from '../store/replica/index.js';
import { createEpicenterRuntime } from './epicenter.js';
import type { AuthorityCarrier, RuntimeBackoff } from './supervisor.js';

export type OpenBunEpicenterOptions =
	| {
			directory: string;
			database?: never;
			/**
			 * The immutable identity of the replica at this path: `null` opens the
			 * unclaimed replica. The composition root selects the path per identity;
			 * the store refuses an identity mismatch (ADR-0178).
			 */
			owner: ReplicaOwner | null;
			limits?: ValidatedLimits;
			carrier?: AuthorityCarrier<BunBlobRead> | null;
			intervalMs?: number;
			backoff?: RuntimeBackoff;
	  }
	| {
			database: string;
			directory?: never;
			owner: ReplicaOwner | null;
			limits?: ValidatedLimits;
			carrier?: AuthorityCarrier<BunBlobRead> | null;
			intervalMs?: number;
			backoff?: RuntimeBackoff;
	  };

function replicaId(): string {
	// The store admits exactly 24 lowercase [a-z0-9] characters.
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const result: string[] = [];
	const bytes = new Uint8Array(32);
	while (result.length < 24) {
		crypto.getRandomValues(bytes);
		for (const byte of bytes) {
			if (byte >= 252) continue;
			const character = alphabet[byte % alphabet.length];
			if (character === undefined) throw new Error('replica id mint failed');
			result.push(character);
			if (result.length === 24) break;
		}
	}
	return result.join('');
}

export async function openBunEpicenter(options: OpenBunEpicenterOptions) {
	if ((options.carrier ?? null) !== null && options.owner === null) {
		throw new TypeError(
			'an unclaimed replica never synchronizes; open with an owner to supply a carrier',
		);
	}
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
			owner: options.owner,
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
