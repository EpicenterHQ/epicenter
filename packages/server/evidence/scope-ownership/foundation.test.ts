/**
 * App ownership foundation evidence.
 * Runs current browser startup in separate processes against the live HTTP
 * mount and SQLite authority. Exercises a durable initialization prototype through
 * restart and competing writers, plus test-only named destination authorization.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCurrentAuthority } from '@epicenter/app/sync';
import { asPrincipalId } from '@epicenter/principal';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';
import { OAuthError } from '../../src/auth/oauth-errors.js';
import { mountStoreSyncApp } from '../../src/store-sync/mount.js';
import type { Env } from '../../src/types.js';
import { authorize, deployment } from './contract.js';
import { openInitialization } from './initial-generation.js';

// The backend substitutes only durable storage. Discovery and routing are live code.
test('independent device caches choose one initial generation and retain it offline', async () => {
	using database = new Database(':memory:');
	const authority = openCurrentAuthority({
		sqlite: createBunSqliteAdapter(database),
	});
	let requests = 0;
	const bothRequested = Promise.withResolvers<void>();
	const app = new Hono<Env>();
	mountStoreSyncApp(app, {
		resolveBearerPrincipal: async (_c, bearer) =>
			bearer === 'alice'
				? Ok({ id: asPrincipalId('alice') })
				: OAuthError.InvalidToken(),
		resolveStore: () => ({
			ledger: () => ({ list: () => [] }),
			authority: () => ({
				async fetch(request) {
					const bytes = new Uint8Array(await request.arrayBuffer());
					if (++requests === 2) bothRequested.resolve();
					await bothRequested.promise;
					return createCurrentDownloadResponse(authority.ensureCurrent(bytes));
				},
			}),
		}),
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (request) => app.fetch(request),
	});
	const devices = [0, 1].map(() =>
		Bun.spawn(
			[
				process.execPath,
				join(
					import.meta.dir,
					'../../../app/evidence/data/app-ownership/device.ts',
				),
				server.url.origin,
			],
			{ stdout: 'pipe', stderr: 'pipe' },
		),
	);
	try {
		const results = await Promise.all(
			devices.map(async (device) => {
				const [stdout, stderr, exit] = await Promise.all([
					new Response(device.stdout).text(),
					new Response(device.stderr).text(),
					device.exited,
				]);
				expect(stderr).toBe('');
				expect(exit).toBe(0);
				return JSON.parse(stdout) as {
					first: number;
					offline: number;
					caches: { name: string }[];
					baseline: number[];
				};
			}),
		);
		expect(results.map((result) => result.first).sort()).toEqual([1, 1]);
		expect(requests).toBe(2);
		expect(results[0]!.baseline).toEqual(results[1]!.baseline);
		expect(authority.capture().generation).toBe(1);
		for (const result of results) {
			expect(result.offline).toBe(result.first);
			expect(result.caches.map((cache) => cache.name)).toContain(
				`epicenter/so.epicenter.notes/accounts/test-authority/alice/data/so.epicenter.firstopen/personal/current`,
			);
		}
	} finally {
		for (const device of devices) device.kill();
		server.stop(true);
	}
}, 15000);

test('socket routing requires a scope address and delegates generation admission to its authority', async () => {
	const reached: string[] = [];
	const app = new Hono<Env>();
	mountStoreSyncApp(app, {
		resolveBearerPrincipal: async (_c, bearer) =>
			bearer === 'alice'
				? Ok({ id: asPrincipalId('alice') })
				: OAuthError.InvalidToken(),
		resolveStore: () => ({
			ledger: () => {
				throw new Error('Socket admission belongs to the current authority');
			},
			authority: (name) => ({
				async fetch() {
					reached.push(name);
					return new Response('Authority unavailable', { status: 503 });
				},
			}),
		}),
	});
	const headers = { authorization: 'Bearer alice', upgrade: 'websocket' };
	expect(
		(
			await app.request(
				'/api/store/v1/sync?dataId=so.epicenter.notes&generation=77',
				{ headers },
			)
		).status,
	).toBe(403);
	expect(reached).toEqual([]);
	const response = await app.request(
		'/api/store/v1/sync?appId=so.epicenter.notes&scope=personal&dataId=so.epicenter.notes&generation=77',
		{ headers },
	);
	expect(response.status).toBe(503);
	expect(reached).toEqual([
		'libraries/apps/so.epicenter.notes/personal/alice/data/so.epicenter.notes',
	]);
	for (const path of ['generations', 'generations/initial', 'generations/77']) {
		expect(
			(
				await app.request('/api/data/v1/so.epicenter.notes/' + path, {
					headers,
				})
			).status,
		).toBe(404);
	}
	expect(reached).toHaveLength(1);
});

for (const crash of ['reservation', 'snapshot', 'admission'] as const) {
	test(`restart after ${crash} keeps one default and never exposes an incomplete snapshot`, () => {
		const directory = mkdtempSync(join(tmpdir(), 'scope-initial-'));
		const open = () =>
			openInitialization(
				join(directory, 'ledger.sqlite'),
				join(directory, 'authority.sqlite'),
			);
		let state = open();
		try {
			const n = state.reserve();
			expect(() => state.admit(n)).toThrow('Snapshot missing');
			expect(() => state.initialize(n, new Uint8Array())).toThrow();
			if (crash !== 'reservation')
				state.initialize(n, new Uint8Array([11, 12]));
			if (crash === 'admission') state.admit(n);
			expect(state.list()).toEqual(crash === 'admission' ? [n] : []);
			expect(state.read(n)).toEqual(
				crash === 'admission' ? new Uint8Array([11, 12]) : undefined,
			);
			state.close();
			state = open();
			const competitor = open();
			try {
				expect(competitor.reserve()).toBe(n);
				competitor.initialize(n, new Uint8Array([21, 22]));
				competitor.admit(n);
				// A delayed initializer must never overwrite a snapshot already admitted.
				state.initialize(n, new Uint8Array([99]));
				state.admit(n);
				expect(state.reserve()).toBe(n);
				expect(state.list()).toEqual([n]);
				expect(state.read(n)).toEqual(
					new Uint8Array(crash === 'reservation' ? [21, 22] : [11, 12]),
				);
			} finally {
				competitor.close();
			}
		} finally {
			state.close();
			rmSync(directory, { recursive: true });
		}
	});
}

test('concurrent initializers reserve one generation and publish one complete winner', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'scope-concurrent-'));
	const clients = Array.from({ length: 12 }, () =>
		openInitialization(
			join(directory, 'ledger.sqlite'),
			join(directory, 'authority.sqlite'),
		),
	);
	const reserved = Promise.withResolvers<void>();
	let count = 0;
	try {
		const numbers = await Promise.all(
			clients.map(async (client, index) => {
				const n = client.reserve();
				if (++count === clients.length) reserved.resolve();
				await reserved.promise;
				client.initialize(n, new Uint8Array([index + 1, 42]));
				await Promise.resolve();
				client.admit(n);
				return n;
			}),
		);
		expect(new Set(numbers).size).toBe(1);
		for (const client of clients) {
			expect(client.list()).toEqual([1]);
			expect(client.read(1)).toEqual(new Uint8Array([1, 42]));
		}
	} finally {
		for (const client of clients) client.close();
		rmSync(directory, { recursive: true });
	}
});

test('initial selection preserves admitted history, import gaps, and explicit imports', () => {
	const state = openInitialization(':memory:', ':memory:');
	try {
		expect(state.allocateImport()).toBe(1); // Interrupted import remains a gap.
		const historical = state.allocateImport();
		state.initialize(historical, new Uint8Array([4]));
		state.admit(historical);
		expect(state.reserve()).toBe(historical);
		const imported = state.allocateImport();
		state.initialize(imported, new Uint8Array([5]));
		state.admit(imported);
		expect(state.reserve()).toBe(historical);
		expect(state.list()).toEqual([2, 3]);
		expect(state.read(historical)).toEqual(new Uint8Array([4]));
	} finally {
		state.close();
	}
});

test('Alice and Bob share only remote Shared within one server and app', () => {
	const a = deployment('https://a.example', 'self-host');
	const b = deployment('https://b.example', 'self-host');
	const alice = authorize(a, 'alice', 'so.epicenter.notes', 'shared');
	const bob = authorize(a, 'bob', 'so.epicenter.notes', 'shared');
	expect(alice.remote).toEqual(bob.remote);
	expect(alice.actor.principalId).toBe('alice');
	expect(bob.actor.principalId).toBe('bob');
	const bindings = [a, b].flatMap((server) =>
		['alice', 'bob'].flatMap((actor) =>
			['personal', 'shared'].map((scope) =>
				authorize(server, actor, 'so.epicenter.notes', scope),
			),
		),
	);
	for (const resource of [
		(binding: typeof alice) => binding.replica,
		(binding: typeof alice) => binding.document('so.epicenter.notes', 1),
		(binding: typeof alice) => binding.blob('blob-1'),
		(binding: typeof alice) => JSON.stringify(binding.sqlite('search')),
		(binding: typeof alice) => binding.recording,
		(binding: typeof alice) => binding.lock,
	]) {
		expect(new Set(bindings.map(resource)).size).toBe(8);
	}
	expect(
		authorize(a, 'alice', 'so.epicenter.notes', 'personal').remote,
	).not.toEqual(authorize(a, 'bob', 'so.epicenter.notes', 'personal').remote);
	expect(alice.remote).not.toEqual(
		authorize(b, 'alice', 'so.epicenter.notes', 'shared').remote,
	);
	expect(alice.remote).not.toEqual(
		authorize(a, 'alice', 'so.epicenter.recorder', 'shared').remote,
	);
});

test('authorization rejects anonymous Shared, Cloud Shared, owner forgery, and malformed destinations', () => {
	const a = deployment('https://a.example', 'self-host');
	const cloud = deployment('https://api.epicenter.so', 'cloud');
	for (const bearer of [null, '', 'mallory'])
		expect(() => authorize(a, bearer, 'so.epicenter.notes', 'shared')).toThrow(
			'Unauthenticated',
		);
	expect(() =>
		authorize(cloud, 'alice', 'so.epicenter.notes', 'shared'),
	).toThrow('Shared unavailable');
	expect(() =>
		authorize(a, 'alice', 'so.epicenter.notes', 'personal', 'bob'),
	).toThrow('Personal owner');
	expect(() => authorize(a, 'alice', '../notes', 'shared')).toThrow(
		'Invalid app',
	);
	expect(() => authorize(a, 'alice', 'so.epicenter.notes', 'unknown')).toThrow(
		'Invalid scope',
	);
	expect(() => deployment('https://a.example', 'cloud')).toThrow(
		'Reserved Cloud',
	);
	const personal = authorize(cloud, 'alice', 'so.epicenter.notes', 'personal');
	expect(personal.actor.authorityId).toBe('epicenter-api');
	expect(personal.remote).toEqual({
		origin: 'https://api.epicenter.so',
		root: 'principals/alice',
	});
	expect(personal.document('so.epicenter.notes', 1)).toBe(
		'epicenter/so.epicenter.notes/accounts/epicenter-api/alice/data/so.epicenter.notes/1',
	);
	expect(personal.sqlite('search')).toEqual([
		'so.epicenter.notes',
		'account',
		'epicenter-api',
		'alice',
		'search',
	]);
});
