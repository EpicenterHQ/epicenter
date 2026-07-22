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

import type { Env, ResolveDocumentPrincipal } from '../types.js';
import { type DataAuthorityV1, openScalarAuthorityV1 } from './authority-v1.js';
import { createAuthorityBlobV1 } from './blob-authority-v1.js';
import { mountBlobV1App } from './blob-v1-route.js';
import { createBunBackupV1Owner } from './bun-backup-v1.js';
import { createAuthorityCaptureManifestV1 } from './capture-manifest-v1.js';
import {
	type BunDataDocumentV1SocketData,
	type BunDocumentRealtimeV1Binding,
	createBunDocumentRealtimeV1Binding,
} from './document-realtime-v1-bun.js';
import {
	DOCUMENT_V1_REALTIME_PATH,
	resolveDocumentRealtimeV1Upgrade,
} from './document-realtime-v1-route.js';
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
	backups: ReturnType<typeof createBunBackupV1Owner>;
	waitForBlobs(): Promise<void>;
};

/** Open a principal-partitioned Bun owner for one Data V1 authority file. */
export function createBunScalarV1Runtime({ dir }: { dir: string }) {
	mkdirSync(dir, { recursive: true });
	const authorities = new Map<PrincipalId, OpenedAuthority>();
	let documentBinding: BunDocumentRealtimeV1Binding | undefined;
	let server: Server<BunDataDocumentV1SocketData> | undefined;
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
			const captures = createAuthorityCaptureManifestV1(database);
			const blobs = createAuthorityBlobV1(
				database,
				createBunBlobFileStore(authorityDirectory(dir, principalId)),
			);
			const backups = createBunBackupV1Owner({
				backupsRoot: join(authorityDirectory(dir, principalId), 'backups'),
				captures,
				blobs,
			});
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
							if (fact.state === 'tombstone') {
								documentBinding?.closeAddress(principalId, fact.address);
								scheduleBlobSweep();
							}
						}
					}
					return result;
				},
			};
			const opened = {
				raw,
				authority,
				blobs,
				backups,
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

	const documents = createBunDocumentRealtimeV1Binding({
		locateAuthority: load,
	});
	documentBinding = documents;

	return {
		locateAuthority: load,
		async locateBlobAuthority(principalId: PrincipalId) {
			const opened = loadEntry(principalId);
			await opened.waitForBlobs();
			return opened.blobs;
		},
		async locateBackupOwner(principalId: PrincipalId) {
			const opened = loadEntry(principalId);
			await opened.waitForBlobs();
			return opened.backups;
		},
		websocket: documents.websocket,
		bindServer(bound: Server<BunDataDocumentV1SocketData>): void {
			server = bound;
		},
		acceptDocumentUpgrade(
			request: Request,
			verified: {
				principalId: PrincipalId;
				address: Parameters<typeof documents.closeAddress>[1];
				authorityLifetime: string;
				authorizationExpiresAt: number;
			},
		): Response {
			if (server === undefined) {
				return new Response('Data document server not bound', { status: 500 });
			}
			return documents.handleAuthorizedUpgrade(request, server, verified);
		},
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closed = true;
			documents.closeAll();
			closing = (async () => {
				const openedAuthorities = [...authorities.values()];
				const settled = await Promise.allSettled(
					openedAuthorities.flatMap((opened) => [
						opened.backups.close(),
						opened.waitForBlobs(),
					]),
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
		resolveDocumentPrincipal,
		runtime,
	}: {
		auth: MiddlewareHandler<E>;
		resolveDocumentPrincipal: ResolveDocumentPrincipal<E>;
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
	app.get(DOCUMENT_V1_REALTIME_PATH, async (c) => {
		const verified = await resolveDocumentRealtimeV1Upgrade(
			c,
			resolveDocumentPrincipal,
		);
		if (verified === undefined) {
			return new Response('WebSocket upgrade refused', { status: 401 });
		}
		return runtime.acceptDocumentUpgrade(c.req.raw, verified);
	});
}
