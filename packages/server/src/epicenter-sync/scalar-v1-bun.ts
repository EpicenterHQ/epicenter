import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
	type BlobByteSource,
	type BunBlobRead,
	createBunBlobFileStore,
} from '@epicenter/data/bun';
import {
	SCALAR_SYNC_V1_LIMITS,
	SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Server } from 'bun';
import type { Hono, MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';
import { type DataAuthorityV1, openScalarAuthorityV1 } from './authority-v1.js';
import { createAuthorityBlobV1 } from './blob-authority-v1.js';
import { mountBlobV1App } from './blob-v1-route.js';
import { mountDocumentV1App } from './document-v1-route.js';
import { mountScalarV1App } from './scalar-v1-route.js';

function encodePathComponent(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

function authorityDirectory(dir: string, principalId: PrincipalId): string {
	const principalDir = join(
		dir,
		'principals',
		encodePathComponent(principalId),
	);
	mkdirSync(principalDir, { recursive: true });
	return principalDir;
}

function authorityPath(dir: string, principalId: PrincipalId): string {
	return join(authorityDirectory(dir, principalId), 'data-v1.sqlite');
}

type BunAuthorityBlobs = ReturnType<
	typeof createAuthorityBlobV1<BlobByteSource, BunBlobRead>
>;

type OpenedAuthority = {
	raw: Database;
	authority: DataAuthorityV1;
	blobs: BunAuthorityBlobs;
	waitForBlobs(): Promise<void>;
};

/** Open a principal-partitioned Bun owner for one Data V1 authority file. */
export function createBunScalarV1Runtime({ dir }: { dir: string }) {
	mkdirSync(dir, { recursive: true });
	const authorities = new Map<PrincipalId, OpenedAuthority>();
	let closed = false;
	let closing: Promise<void> | undefined;

	function loadEntry(principalId: PrincipalId): OpenedAuthority {
		if (closed) throw new Error('Bun scalar V1 runtime is closed');
		const existing = authorities.get(principalId);
		if (existing !== undefined) return existing;

		const raw = new Database(authorityPath(dir, principalId), {
			create: true,
			strict: true,
		});
		try {
			raw.run('PRAGMA journal_mode = WAL');
			const database = createBunSqliteAdapter(raw);
			const stored = openScalarAuthorityV1({
				database,
				limits: SCALAR_SYNC_V1_LIMITS,
				initialize: { authorityLifetime: crypto.randomUUID() },
			});
			const blobs = createAuthorityBlobV1(
				database,
				createBunBlobFileStore(authorityDirectory(dir, principalId)),
			);
			let blobMaintenance = blobs.reopenSweep();
			void blobMaintenance.catch(() => undefined);
			function scheduleBlobSweep(): void {
				blobMaintenance = blobMaintenance.then(
					() => blobs.sweepDebris(),
					() => blobs.sweepDebris(),
				);
				void blobMaintenance.catch(() => undefined);
			}
			const authority: DataAuthorityV1 = {
				...stored,
				submit(request) {
					const result = stored.submit(request);
					if (result.error === null) {
						for (const fact of result.data.facts) {
							if (fact.state === 'tombstone') scheduleBlobSweep();
						}
					}
					return result;
				},
			};
			const opened = {
				raw,
				authority,
				blobs,
				waitForBlobs: () => blobMaintenance,
			};
			authorities.set(principalId, opened);
			return opened;
		} catch (cause) {
			raw.close();
			throw cause;
		}
	}

	function load(principalId: PrincipalId): DataAuthorityV1 {
		return loadEntry(principalId).authority;
	}

	return {
		locateAuthority: load,
		async locateBlobAuthority(principalId: PrincipalId) {
			const opened = loadEntry(principalId);
			await opened.waitForBlobs();
			return opened.blobs;
		},
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closed = true;
			closing = (async () => {
				const openedAuthorities = [...authorities.values()];
				const settled = await Promise.allSettled(
					openedAuthorities.map((opened) => opened.waitForBlobs()),
				);
				for (const opened of openedAuthorities) opened.raw.close();
				authorities.clear();
				const failures = settled
					.filter(
						(result): result is PromiseRejectedResult =>
							result.status === 'rejected',
					)
					.map((result) => result.reason);
				if (failures.length > 0) {
					throw new AggregateError(failures, 'Bun blob maintenance failed');
				}
			})();
			return closing;
		},
	};
}

export type BunScalarV1Runtime = ReturnType<typeof createBunScalarV1Runtime>;

/** Mount the authenticated Data V1 surfaces on a Bun deployment. */
export function mountBunScalarV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		runtime,
	}: {
		auth: MiddlewareHandler<E>;
		runtime: BunScalarV1Runtime;
	},
): void {
	mountScalarV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		rawSubmissionBytes: SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
		locateAuthority: runtime.locateAuthority,
	});
	mountDocumentV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		locateAuthority: runtime.locateAuthority,
	});
	mountBlobV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		locateAuthority: runtime.locateBlobAuthority,
	});
}
