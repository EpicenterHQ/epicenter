import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
	ExchangeRequest,
	ExchangeResponse,
} from '@epicenter/data/protocol';
import type { DocumentAddress } from '@epicenter/document-sync';
import type { PrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Server } from 'bun';
import type { Hono, MiddlewareHandler } from 'hono';

import type { Env, ResolveDocumentPrincipal } from '../types.js';
import { openEpicenterSyncAuthority } from './authority.js';
import {
	type BunEpicenterDocumentSocketData,
	createBunEpicenterDocumentBinding,
} from './document-bun.js';
import {
	mountEpicenterSyncRoute,
	resolveEpicenterDocumentUpgrade,
} from './route.js';

type OpenPrincipalAuthority = {
	raw: Database;
	exchange(request: ExchangeRequest): ExchangeResponse;
};

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
	return join(principalDir, 'epicenter.sqlite');
}

function readDatabaseSize(database: Database): number {
	const pageCount = database
		.query<{ page_count: number }, []>('PRAGMA page_count')
		.get()?.page_count;
	const pageSize = database
		.query<{ page_size: number }, []>('PRAGMA page_size')
		.get()?.page_size;
	if (pageCount === undefined || pageSize === undefined) {
		throw new Error('Could not read Epicenter authority SQLite size');
	}
	return pageCount * pageSize;
}

/** Open the Bun runtime for principal-partitioned Epicenter synchronization. */
export function createBunEpicenterSyncRuntime({ dir }: { dir: string }) {
	mkdirSync(dir, { recursive: true });
	const authorities = new Map<PrincipalId, OpenPrincipalAuthority>();
	let server: Server<BunEpicenterDocumentSocketData> | undefined;
	let closed = false;

	function load(principalId: PrincipalId): OpenPrincipalAuthority {
		if (closed) throw new Error('Bun Epicenter sync runtime is closed');
		const existing = authorities.get(principalId);
		if (existing !== undefined) return existing;

		const raw = new Database(authorityPath(dir, principalId), {
			create: true,
			strict: true,
		});
		try {
			raw.run('PRAGMA journal_mode = WAL');
			const database = createBunSqliteAdapter(raw);
			const authority = openEpicenterSyncAuthority({
				database,
				readDatabaseSize: () => readDatabaseSize(raw),
			});
			const opened = { raw, exchange: authority.exchange };
			authorities.set(principalId, opened);
			return opened;
		} catch (cause) {
			raw.close();
			throw cause;
		}
	}

	const documents = createBunEpicenterDocumentBinding({
		locateDatabase: (principalId) =>
			createBunSqliteAdapter(load(principalId as PrincipalId).raw),
	});

	function exchange(principalId: PrincipalId, request: ExchangeRequest) {
		const response = load(principalId).exchange(request);
		if ('refusal' in response || request.batch === undefined) return response;
		for (const change of request.batch.changes) {
			if (change.kind !== 'delete') continue;
			documents.closeRow(principalId, {
				namespace: change.namespace,
				table: change.table,
				rowId: change.rowId,
			});
		}
		return response;
	}

	return {
		locateAuthority: (principalId: PrincipalId) => (request: ExchangeRequest) =>
			exchange(principalId, request),
		websocket: documents.websocket,
		bindServer(bound: Server<BunEpicenterDocumentSocketData>): void {
			server = bound;
		},
		acceptDocumentUpgrade({
			request,
			principalId,
			address,
			authorizationExpiresAt,
		}: {
			request: Request;
			principalId: string;
			address: DocumentAddress;
			authorizationExpiresAt: number;
		}): Response {
			if (server === undefined) {
				return new Response('Epicenter document server not bound', {
					status: 500,
				});
			}
			return documents.handleAuthorizedUpgrade(request, server, {
				principalId,
				address,
				authorizationExpiresAt,
			});
		},
		close(): void {
			if (closed) return;
			closed = true;
			documents.closeAll();
			for (const authority of authorities.values()) authority.raw.close();
			authorities.clear();
		},
	};
}

export type BunEpicenterSyncRuntime = ReturnType<
	typeof createBunEpicenterSyncRuntime
>;

/** Mount the Bun scalar exchange and row-document WebSocket route. */
export function mountBunEpicenterSyncApp<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveDocumentPrincipal,
		runtime,
	}: {
		auth: MiddlewareHandler<E>;
		resolveDocumentPrincipal: ResolveDocumentPrincipal<E>;
		runtime: BunEpicenterSyncRuntime;
	},
): void {
	mountEpicenterSyncRoute(app, {
		auth,
		locateAuthority: runtime.locateAuthority,
	});
	app.get('/api/sync/v1/documents/:namespace/:table/:rowId', async (c) => {
		const authorization = await resolveEpicenterDocumentUpgrade(
			c,
			resolveDocumentPrincipal,
		);
		if (authorization === undefined) {
			return new Response('WebSocket upgrade refused', { status: 401 });
		}
		return runtime.acceptDocumentUpgrade({
			request: c.req.raw,
			...authorization,
		});
	});
}
