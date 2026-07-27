/**
 * Epicenter Row-Document HTTP Synchronization Tests
 *
 * Drives the real client runtime (@epicenter/data) against the mounted Bun
 * authority routes over HTTP: automatic durable publication, restart
 * resumption, explicit conditional pull, terminal bound refusal, deletion
 * racing publication, and authority-side compaction.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Principal } from '@epicenter/auth';
import {
	createEpicenter,
	createHttpScalarTransport,
	defineLens,
	defineTable,
	openReplicaV1,
} from '@epicenter/data';
import { createHttpDocumentTransports } from '@epicenter/document-sync';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { Hono } from 'hono';
import { expectOk } from 'wellcrafted/testing';

import type { Env } from '../types.js';
import {
	createBunEpicenterSyncRuntime,
	mountBunEpicenterSyncApp,
} from './bun.js';

const PRINCIPAL_ID = asPrincipalId('alice');
const NAMESPACE = 'so.epicenter.tests';
const TABLE = 'notes';
const definition = defineTable({
	fields: { title: field.string() },
});
const lens = defineLens({
	namespace: NAMESPACE,
	tables: { notes: definition },
	values: {},
});

function rowAddress(rowId: string) {
	return {
		kind: 'row',
		namespace: NAMESPACE,
		tableName: TABLE,
		rowId,
	} as const;
}

function openServer() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-doc-integration-'));
	const runtime = createBunEpicenterSyncRuntime({ dir });
	const app = new Hono<Env>();
	mountBunEpicenterSyncApp(app, {
		runtime,
		auth: async (c, next) => {
			if (c.req.header('authorization') !== 'Bearer token') {
				return new Response(null, { status: 401 });
			}
			c.set('principal', Principal.assert({ id: PRINCIPAL_ID }));
			await next();
		},
	});
	const authorizedFetch = async (url: URL, init: RequestInit) =>
		app.request(url.toString(), {
			...init,
			headers: {
				...(init.headers as Record<string, string> | undefined),
				authorization: 'Bearer token',
			},
		});
	return {
		app,
		runtime,
		authorizedFetch,
		session: {
			deploymentId: 'https://authority.test/',
			principalId: PRINCIPAL_ID as string,
			// The real production carrier against the real mounted routes, so this
			// proves document sync still works over the scalar cutover rather than
			// over a test-only shortcut.
			transport: createHttpScalarTransport({
				baseUrl: 'https://authority.test/',
				fetch: async (url, init) =>
					app.request(url, {
						...init,
						headers: {
							...(init?.headers ?? {}),
							authorization: 'Bearer token',
						},
					}),
			}),
			...createHttpDocumentTransports({
				baseUrl: 'https://authority.test/',
				fetch: authorizedFetch,
			}),
		},
		cleanup() {
			runtime.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function openClient(path = ':memory:') {
	const raw = new Database(path, { strict: true });
	const database = createBunSqliteAdapter(raw);
	const replica = expectOk(openReplicaV1({ database }));
	const epicenter = createEpicenter({ replica, database });
	return {
		raw,
		database,
		epicenter,
		notes: epicenter.bind(lens).tables.notes,
	};
}

function publicationRow(
	database: ReturnType<typeof createBunSqliteAdapter>,
	rowId: string,
) {
	return database.all<{
		revision: number;
		accepted_revision: number;
		sync_issue: string | null;
	}>(
		`SELECT revision, accepted_revision, sync_issue
		 FROM document_publication
		 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
		[NAMESPACE, TABLE, rowId],
	)[0];
}

async function waitFor(
	check: () => boolean | Promise<boolean>,
	label = 'condition',
): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (await check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

test('a local edit publishes automatically over HTTP and settles', async () => {
	const server = openServer();
	const client = openClient();
	try {
		expectOk(await client.epicenter.attachSync(server.session));
		const row = await client.notes.create({ title: 'auto publish' });
		const document = await client.notes.openDocument(row.id);
		document.transact(() => document.get('content').insert(0, 'typed text'));

		await waitFor(() => {
			const record = publicationRow(client.database, row.id);
			return (
				record !== undefined && record.accepted_revision === record.revision
			);
		}, 'publication settlement');

		const pulled = server.runtime.pullDocument(
			PRINCIPAL_ID,
			rowAddress(row.id),
			undefined,
		);
		if (pulled.kind !== 'state' || pulled.state === undefined) {
			throw new Error('Expected accepted authority state');
		}
		const hydrated = new Y.Doc();
		try {
			Y.applyUpdateV2(hydrated, pulled.state);
			expect(hydrated.get('content').toString()).toBe('typed text');
		} finally {
			hydrated.destroy();
		}
		await document[Symbol.asyncDispose]();
	} finally {
		await client.epicenter[Symbol.asyncDispose]();
		client.raw.close();
		server.cleanup();
	}
});

test('restart resumes dirty publication from SQLite', async () => {
	const server = openServer();
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-doc-client-'));
	const path = join(dir, 'client.sqlite');
	let rowId: string;
	try {
		{
			// First run: durable local work with no attached session.
			const client = openClient(path);
			const row = await client.notes.create({ title: 'offline note' });
			rowId = row.id;
			const document = await client.notes.openDocument(row.id);
			document.transact(() =>
				document.get('content').insert(0, 'written offline'),
			);
			await document[Symbol.asyncDispose]();
			expect(publicationRow(client.database, row.id)?.accepted_revision).toBe(
				0,
			);
			await client.epicenter[Symbol.asyncDispose]();
			client.raw.close();
		}

		// Second run: attaching alone resumes and publishes the owed work.
		const reopened = openClient(path);
		try {
			expectOk(await reopened.epicenter.attachSync(server.session));
			await waitFor(() => {
				const record = publicationRow(reopened.database, rowId);
				return (
					record !== undefined && record.accepted_revision === record.revision
				);
			}, 'resumed publication');
			const pulled = server.runtime.pullDocument(
				PRINCIPAL_ID,
				rowAddress(rowId),
				undefined,
			);
			expect(pulled.kind).toBe('state');
		} finally {
			await reopened.epicenter[Symbol.asyncDispose]();
			reopened.raw.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
		server.cleanup();
	}
});

test('two replicas edit and pull the same document without owing inbound work', async () => {
	const server = openServer();
	const author = openClient();
	const reader = openClient();
	try {
		expectOk(await author.epicenter.attachSync(server.session));
		const row = await author.notes.create({ title: 'shared note' });
		const document = await author.notes.openDocument(row.id);
		document.transact(() => document.get('content').insert(0, 'from author'));
		await waitFor(() => {
			const record = publicationRow(author.database, row.id);
			return (
				record !== undefined && record.accepted_revision === record.revision
			);
		}, 'author publication');
		await document[Symbol.asyncDispose]();

		// The reader learns the row through the scalar exchange, opens its
		// local (empty) document, and explicitly pulls the accepted body.
		expectOk(await reader.epicenter.attachSync(server.session));
		await waitFor(
			async () => expectOk(await reader.notes.get(row.id)) !== undefined,
			'scalar row arrival',
		);
		const readerDocument = await reader.notes.openDocument(row.id);
		expect(readerDocument.get('content').toString()).toBe('');
		expectOk(await readerDocument.pull());
		expect(readerDocument.get('content').toString()).toBe('from author');
		// Accepted inbound state never creates an outbound obligation.
		expect(publicationRow(reader.database, row.id)).toBeUndefined();

		// The reader edits that same document and publishes it automatically.
		readerDocument.transact(() =>
			readerDocument.get('content').insert(11, ' and reader'),
		);
		await waitFor(() => {
			const record = publicationRow(reader.database, row.id);
			return (
				record !== undefined && record.accepted_revision === record.revision
			);
		}, 'reader publication');

		// The original author explicitly pulls the accepted merge. Applying those
		// inbound bytes must not advance its already-settled publication revision.
		const authorDocument = await author.notes.openDocument(row.id);
		expectOk(await authorDocument.pull());
		expect(authorDocument.get('content').toString()).toBe(
			'from author and reader',
		);
		expect(publicationRow(author.database, row.id)).toEqual({
			revision: 1,
			accepted_revision: 1,
			sync_issue: null,
		});

		// An unchanged repeat pull transfers no document body.
		let bodies = 0;
		const countingTransports = createHttpDocumentTransports({
			baseUrl: 'https://authority.test/',
			fetch: async (url, init) => {
				const response = await server.authorizedFetch(url, init);
				if (response.status === 200) bodies += 1;
				return response;
			},
		});
		const versioned = await countingTransports.pullDocument({
			address: rowAddress(row.id),
			sinceVersion: undefined,
		});
		if (versioned.kind !== 'state') throw new Error('Expected state');
		const unchanged = await countingTransports.pullDocument({
			address: rowAddress(row.id),
			sinceVersion: versioned.version,
		});
		expect(unchanged.kind).toBe('unchanged');
		expect(bodies).toBe(1);

		await authorDocument[Symbol.asyncDispose]();
		await readerDocument[Symbol.asyncDispose]();
	} finally {
		await author.epicenter[Symbol.asyncDispose]();
		await reader.epicenter[Symbol.asyncDispose]();
		author.raw.close();
		reader.raw.close();
		server.cleanup();
	}
});

test('deletion racing publication cannot resurrect the document', async () => {
	const server = openServer();
	const author = openClient();
	const deleter = openClient();
	try {
		expectOk(await author.epicenter.attachSync(server.session));
		const row = await author.notes.create({ title: 'doomed' });
		await waitFor(() => {
			const pulled = server.runtime.pullDocument(
				PRINCIPAL_ID,
				rowAddress(row.id),
				undefined,
			);
			return pulled.kind !== 'not-live';
		}, 'row arrival at authority');

		// Another replica deletes the row at the authority first.
		expectOk(await deleter.epicenter.attachSync(server.session));
		await waitFor(
			async () => expectOk(await deleter.notes.get(row.id)) !== undefined,
			'row arrival at deleter',
		);
		expect(await deleter.notes.delete(row.id)).toBe(true);
		await waitFor(() => {
			const pulled = server.runtime.pullDocument(
				PRINCIPAL_ID,
				rowAddress(row.id),
				undefined,
			);
			return pulled.kind === 'not-live';
		}, 'deletion arrival at authority');

		// A late in-flight publication for the dead address is refused and
		// leaves no document bytes behind.
		const authored = new Y.Doc();
		let update: Uint8Array;
		try {
			authored.get('content').insert(0, 'late edit');
			update = new Uint8Array(Y.encodeStateAsUpdateV2(authored));
		} finally {
			authored.destroy();
		}
		const outcome = server.runtime.publishDocument(
			PRINCIPAL_ID,
			rowAddress(row.id),
			update,
		);
		expect(outcome).toEqual({ outcome: 'not-live' });
		expect(
			server.runtime.pullDocument(PRINCIPAL_ID, rowAddress(row.id), undefined)
				.kind,
		).toBe('not-live');
	} finally {
		await author.epicenter[Symbol.asyncDispose]();
		await deleter.epicenter[Symbol.asyncDispose]();
		author.raw.close();
		deleter.raw.close();
		server.cleanup();
	}
});

test('an oversized candidate is refused terminally without blocking others', async () => {
	const server = openServer();
	const client = openClient();
	try {
		expectOk(await client.epicenter.attachSync(server.session));
		const big = await client.notes.create({ title: 'too big' });
		const small = await client.notes.create({ title: 'fine' });

		const bigDocument = await client.notes.openDocument(big.id);
		bigDocument.transact(() =>
			bigDocument.get('content').insert(0, 'x'.repeat(1_100_000)),
		);
		const smallDocument = await client.notes.openDocument(small.id);
		smallDocument.transact(() =>
			smallDocument.get('content').insert(0, 'small enough'),
		);

		await waitFor(() => {
			const refused = publicationRow(client.database, big.id);
			const settled = publicationRow(client.database, small.id);
			return (
				refused?.sync_issue === 'too-large' &&
				settled !== undefined &&
				settled.accepted_revision === settled.revision
			);
		}, 'terminal refusal beside settlement');

		// The refused lineage stays locally durable and observable while the
		// authority keeps no bytes for it.
		expect(await bigDocument.syncIssue()).toEqual({ kind: 'too-large' });
		expect(bigDocument.get('content').length).toBe(1_100_000);
		expect(
			server.runtime.pullDocument(PRINCIPAL_ID, rowAddress(big.id), undefined),
		).toMatchObject({ kind: 'state', state: undefined });

		await bigDocument[Symbol.asyncDispose]();
		await smallDocument[Symbol.asyncDispose]();
	} finally {
		await client.epicenter[Symbol.asyncDispose]();
		client.raw.close();
		server.cleanup();
	}
}, 20_000);

test('the authority compacts a covered chain into one baseline', async () => {
	const server = openServer();
	const client = openClient();
	try {
		expectOk(await client.epicenter.attachSync(server.session));
		const row = await client.notes.create({ title: 'compact' });
		await waitFor(() => {
			const pulled = server.runtime.pullDocument(
				PRINCIPAL_ID,
				rowAddress(row.id),
				undefined,
			);
			return pulled.kind !== 'not-live';
		}, 'row arrival at authority');

		const authored = new Y.Doc();
		try {
			for (let index = 0; index < 70; index += 1) {
				authored
					.get('content')
					.insert(authored.get('content').length, `entry ${index};`);
				const outcome = server.runtime.publishDocument(
					PRINCIPAL_ID,
					rowAddress(row.id),
					new Uint8Array(Y.encodeStateAsUpdateV2(authored)),
				);
				expect(outcome).toEqual({ outcome: 'accepted' });
			}
			const pulled = server.runtime.pullDocument(
				PRINCIPAL_ID,
				rowAddress(row.id),
				undefined,
			);
			if (pulled.kind !== 'state' || pulled.state === undefined) {
				throw new Error('Expected accepted authority state');
			}
			const hydrated = new Y.Doc();
			try {
				Y.applyUpdateV2(hydrated, pulled.state);
				expect(hydrated.get('content').toString()).toBe(
					authored.get('content').toString(),
				);
			} finally {
				hydrated.destroy();
			}
		} finally {
			authored.destroy();
		}
	} finally {
		await client.epicenter[Symbol.asyncDispose]();
		client.raw.close();
		server.cleanup();
	}
});
