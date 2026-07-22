import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

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

function authorityPath(dir: string, principalId: PrincipalId): string {
	const principalDir = join(
		dir,
		'principals',
		encodePathComponent(principalId),
	);
	mkdirSync(principalDir, { recursive: true });
	return join(principalDir, 'data-v1.sqlite');
}

/** Open a principal-partitioned Bun owner for one Data V1 authority file. */
export function createBunScalarV1Runtime({ dir }: { dir: string }) {
	mkdirSync(dir, { recursive: true });
	const authorities = new Map<
		PrincipalId,
		{ raw: Database; authority: DataAuthorityV1 }
	>();
	let documentBinding: BunDocumentRealtimeV1Binding | undefined;
	let server: Server<BunDataDocumentV1SocketData> | undefined;
	let closed = false;

	function load(principalId: PrincipalId): DataAuthorityV1 {
		if (closed) throw new Error('Bun scalar V1 runtime is closed');
		const existing = authorities.get(principalId);
		if (existing !== undefined) return existing.authority;

		const raw = new Database(authorityPath(dir, principalId), {
			create: true,
			strict: true,
		});
		try {
			raw.run('PRAGMA journal_mode = WAL');
			const stored = openScalarAuthorityV1({
				database: createBunSqliteAdapter(raw),
				limits: SCALAR_SYNC_V1_LIMITS,
				initialize: { authorityLifetime: crypto.randomUUID() },
			});
			const authority: DataAuthorityV1 = {
				...stored,
				submit(request) {
					const result = stored.submit(request);
					if (result.error === null) {
						for (const fact of result.data.facts) {
							if (fact.state === 'tombstone') {
								documentBinding?.closeAddress(principalId, fact.address);
							}
						}
					}
					return result;
				},
			};
			authorities.set(principalId, { raw, authority });
			return authority;
		} catch (cause) {
			raw.close();
			throw cause;
		}
	}

	const documents = createBunDocumentRealtimeV1Binding({
		locateAuthority: load,
	});
	documentBinding = documents;

	return {
		locateAuthority: load,
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
		close(): void {
			if (closed) return;
			closed = true;
			documents.closeAll();
			for (const opened of authorities.values()) opened.raw.close();
			authorities.clear();
		},
	};
}

export type BunScalarV1Runtime = ReturnType<typeof createBunScalarV1Runtime>;

/** Mount the two authenticated scalar V1 routes on a Bun deployment. */
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
