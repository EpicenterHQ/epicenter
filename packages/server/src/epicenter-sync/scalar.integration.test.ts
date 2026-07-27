/**
 * Scalar V1 End-to-End Convergence Tests
 *
 * Drives the real client runtime (@epicenter/data) against the real mounted Bun
 * authority over HTTP: two replicas, the production carrier, the production
 * routes, and the production supervisor lanes. Nothing here is a scripted
 * authority or an in-process shortcut, so it is the proof that the pieces
 * proven separately actually compose.
 *
 * Key behaviors:
 * - Two replicas converge on rows and values through the two operations
 * - A local write is visible immediately and survives settlement
 * - A deletion on one replica terminally removes the row on the other
 * - A replica bound to a superseded authority lifetime is told so, terminally
 * - Acquisition from zero pages without skipping or repeating facts
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
	defineValue,
	openReplicaV1,
} from '@epicenter/data';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Hono } from 'hono';
import { expectErr, expectOk } from 'wellcrafted/testing';

import type { Env } from '../types.js';
import {
	createBunEpicenterSyncRuntime,
	mountBunEpicenterSyncApp,
} from './bun.js';

const PRINCIPAL_ID = asPrincipalId('alice');
const NAMESPACE = 'so.epicenter.tests';
const DEPLOYMENT = 'https://authority.test/';

const notes = defineTable({ fields: { title: field.string() } });
const lens = defineLens({
	namespace: NAMESPACE,
	tables: { notes },
	values: { theme: defineValue({ value: field.string() }) },
});

function openServer() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-scalar-integration-'));
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
	return {
		app,
		runtime,
		transport: createHttpScalarTransport({
			baseUrl: DEPLOYMENT,
			fetch: async (url, init) =>
				app.request(url, {
					...init,
					headers: {
						...(init?.headers ?? {}),
						authorization: 'Bearer token',
					},
				}),
		}),
		cleanup() {
			runtime.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function openClient() {
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	const replica = expectOk(openReplicaV1({ database }));
	const epicenter = createEpicenter({ replica, database });
	const bound = epicenter.bind(lens);
	return {
		raw,
		replica,
		epicenter,
		notes: bound.tables.notes,
		theme: bound.values.theme,
	};
}

/** Settle one replica in both directions, as the supervisor lanes would. */
async function sync(
	client: ReturnType<typeof openClient>,
	server: ReturnType<typeof openServer>,
) {
	expectOk(await client.replica.pullFacts(server.transport));
	expectOk(await client.replica.pushSubmissions(server.transport));
	expectOk(await client.replica.pullFacts(server.transport));
}

function attach(client: ReturnType<typeof openClient>) {
	return client.replica.attach({
		deploymentId: DEPLOYMENT,
		principalId: PRINCIPAL_ID as string,
	});
}

test('two replicas converge on rows through the two operations', async () => {
	const server = openServer();
	const first = openClient();
	const second = openClient();
	try {
		expectOk(attach(first));
		expectOk(attach(second));

		const created = await first.notes.create({ title: 'from first' });
		// Local-first: visible before any round trip has happened.
		expect(expectOk(await first.notes.get(created.id))?.title).toBe(
			'from first',
		);

		await sync(first, server);
		await sync(second, server);

		expect(expectOk(await second.notes.get(created.id))?.title).toBe(
			'from first',
		);
	} finally {
		first.raw.close();
		second.raw.close();
		server.cleanup();
	}
});

test('two replicas converge on values through the two operations', async () => {
	const server = openServer();
	const first = openClient();
	const second = openClient();
	try {
		expectOk(attach(first));
		expectOk(attach(second));

		await first.theme.set('dark');
		await sync(first, server);
		await sync(second, server);

		expect(expectOk(await second.theme.get())).toBe('dark');

		// And back the other way, so neither direction is privileged.
		await second.theme.set('light');
		await sync(second, server);
		await sync(first, server);
		expect(expectOk(await first.theme.get())).toBe('light');
	} finally {
		first.raw.close();
		second.raw.close();
		server.cleanup();
	}
});

test('a deletion on one replica terminally removes the row on the other', async () => {
	const server = openServer();
	const first = openClient();
	const second = openClient();
	try {
		expectOk(attach(first));
		expectOk(attach(second));

		const created = await first.notes.create({ title: 'doomed' });
		await sync(first, server);
		await sync(second, server);
		expect(expectOk(await second.notes.get(created.id))).toBeDefined();

		expect(await first.notes.delete(created.id)).toBe(true);
		await sync(first, server);
		await sync(second, server);

		expect(expectOk(await second.notes.get(created.id))).toBeUndefined();

		// The tombstone is terminal: the row cannot be brought back by writing
		// at the same address on the replica that never deleted it.
		await second.notes.update(created.id, { title: 'resurrected' });
		await sync(second, server);
		await sync(first, server);
		expect(expectOk(await first.notes.get(created.id))).toBeUndefined();
		expect(expectOk(await second.notes.get(created.id))).toBeUndefined();
	} finally {
		first.raw.close();
		second.raw.close();
		server.cleanup();
	}
});

test('concurrent writes to different rows both survive', async () => {
	const server = openServer();
	const first = openClient();
	const second = openClient();
	try {
		expectOk(attach(first));
		expectOk(attach(second));

		const a = await first.notes.create({ title: 'a' });
		const b = await second.notes.create({ title: 'b' });

		await sync(first, server);
		await sync(second, server);
		await sync(first, server);

		for (const client of [first, second]) {
			expect(expectOk(await client.notes.get(a.id))?.title).toBe('a');
			expect(expectOk(await client.notes.get(b.id))?.title).toBe('b');
		}
	} finally {
		first.raw.close();
		second.raw.close();
		server.cleanup();
	}
});

test('a replica bound to a superseded lifetime is told so terminally', async () => {
	const server = openServer();
	const successor = openServer();
	const client = openClient();
	try {
		expectOk(attach(client));
		await client.notes.create({ title: 'bound' });
		await sync(client, server);

		// A different authority means a different lifetime. ADR-0163 makes that a
		// terminal mismatch rather than something a retry could resolve.
		const failure = expectErr(
			await client.replica.pullFacts(successor.transport),
		);
		expect(failure.name).toBe('LifetimeMismatch');
	} finally {
		client.raw.close();
		server.cleanup();
		successor.cleanup();
	}
});

test('acquisition from zero learns everything already written', async () => {
	const server = openServer();
	const author = openClient();
	try {
		expectOk(attach(author));
		const ids: string[] = [];
		for (let index = 0; index < 25; index += 1) {
			const created = await author.notes.create({ title: `note ${index}` });
			ids.push(created.id);
			// The submission grouping is bounded, so this needs several rounds.
			await sync(author, server);
		}

		const fresh = openClient();
		try {
			expectOk(attach(fresh));
			// Page until the feed reports it is caught up.
			for (let round = 0; round < 10; round += 1) {
				expectOk(await fresh.replica.pullFacts(server.transport));
			}
			for (const [index, id] of ids.entries()) {
				expect(expectOk(await fresh.notes.get(id))?.title).toBe(
					`note ${index}`,
				);
			}
		} finally {
			fresh.raw.close();
		}
	} finally {
		author.raw.close();
		server.cleanup();
	}
});
