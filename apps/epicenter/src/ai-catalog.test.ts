/**
 * Desktop AI catalog persistence and access tests.
 * Verifies serialized durable updates, keychain isolation, legacy-data retention,
 * reactive snapshots, and retirement when credentials or destinations change.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/principal';
import { type AiCatalog, createAiCatalog } from './ai-catalog.js';
import {
	type AppSecretOwner,
	createProcessMemoryAppSecrets,
} from './app-secrets.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	await Promise.all(
		cleanup
			.splice(0)
			.reverse()
			.map((dispose) => dispose()),
	);
});
async function setup(
	options: { secrets?: AppSecretOwner; fetch?: typeof globalThis.fetch } = {},
) {
	const dataRoot = await mkdtemp(join(tmpdir(), 'epicenter-ai-catalog-'));
	const secrets = options.secrets ?? createProcessMemoryAppSecrets();
	const catalog = await createAiCatalog({
		dataRoot,
		secrets,
		fetch: options.fetch,
	});
	cleanup.push(
		() => rm(dataRoot, { recursive: true, force: true }),
		() => catalog.close(),
	);
	return { dataRoot, secrets, catalog };
}
async function add(catalog: AiCatalog, apiKey?: string) {
	const { result } = await catalog.execute({
		type: 'add',
		input: { baseUrl: 'https://models.example/v1', apiKey },
	});
	return catalog.getAll().connections.find((entry) => entry.id === result)!;
}

test('each account restores its own catalog and keys without adopting the no-account catalog', async () => {
	const { catalog: local, dataRoot, secrets } = await setup();
	await add(local, 'no-account-key');
	const seen = new Set<string>();
	for (const [authorityId, person] of [
		['one', 'alice'],
		['one', 'bob'],
		['two', 'alice'],
		['one', 'alice'],
	]) {
		const owner = `${authorityId}:${person}`;
		const account = {
			authorityId: authorityId!,
			principalId: asPrincipalId(person!),
		};
		let authorization: string | null = null;
		const catalog = await createAiCatalog({
			dataRoot,
			secrets,
			account,
			fetch: (async (_input, init) => {
				authorization = new Headers(init?.headers).get('authorization');
				return Response.json({ data: [] });
			}) as typeof fetch,
		});
		try {
			expect(catalog.getAll().connections).toHaveLength(
				seen.has(owner) ? 1 : 0,
			);
			const entry = seen.has(owner)
				? catalog.getAll().connections[0]!
				: await add(catalog, owner);
			const response = await catalog.proxy(
				entry.id,
				entry.accessVersion,
				new Request('https://host.test/models'),
				'models',
			);
			await response.text();
			expect(authorization as string | null).toBe(`Bearer ${owner}`);
			seen.add(owner);
		} finally {
			await catalog.close();
		}
	}
	expect(local.getAll().connections).toHaveLength(1);
});

test('concurrent saves retain all records and restart preserves metadata without secrets', async () => {
	const { catalog, dataRoot, secrets } = await setup();
	await Promise.all([
		add(catalog, 'private-alpha'),
		add(catalog, 'private-beta'),
	]);
	const snapshot = catalog.getAll();
	expect(snapshot.connections).toHaveLength(2);
	expect(snapshot.revision).toBe(2);
	const persisted = await readFile(
		join(dataRoot, 'ai/no-account/connections.json'),
		'utf8',
	);
	expect(persisted).not.toContain('private-alpha');
	expect(persisted).not.toContain('private-beta');
	expect(JSON.stringify(snapshot)).not.toContain('secretVersion');
	await catalog.close();
	const reopened = await createAiCatalog({ dataRoot, secrets });
	cleanup.push(() => reopened.close());
	expect(reopened.getAll()).toEqual(snapshot);
});

test('subscription starts immediately and publishes detached snapshots after commit', async () => {
	const { catalog, dataRoot } = await setup();
	const revisions: number[] = [];
	const stop = catalog.subscribe((snapshot) => {
		revisions.push(snapshot.revision);
		snapshot.connections.length = 0;
	});
	await add(catalog);
	expect(revisions).toEqual([0, 1]);
	expect(catalog.getAll().connections).toHaveLength(1);
	expect(
		JSON.parse(
			await readFile(join(dataRoot, 'ai/no-account/connections.json'), 'utf8'),
		).revision,
	).toBe(1);
	stop();
	await add(catalog);
	expect(revisions).toEqual([0, 1]);
});

test('same-endpoint connections use only their own key and metadata edits retain access', async () => {
	const requests: Request[] = [];
	const { catalog } = await setup({
		fetch: (async (input, init) => {
			requests.push(new Request(input, init));
			return new Response('ok');
		}) as typeof globalThis.fetch,
	});
	const first = await add(catalog, 'first-key');
	const second = await add(catalog, 'second-key');
	await catalog.execute({
		type: 'update',
		id: first.id,
		patch: { name: 'Renamed', models: ['manual'] },
	});
	expect(catalog.getAll().connections[0]!.accessVersion).toBe(
		first.accessVersion,
	);
	for (const connection of [first, second]) {
		const response = await catalog.proxy(
			connection.id,
			connection.accessVersion,
			new Request('http://host/inference', {
				headers: {
					authorization: 'Bearer host-account',
					cookie: 'host=session',
				},
			}),
			'models',
		);
		await response.text();
	}
	expect(
		requests.map((request) => request.headers.get('authorization')),
	).toEqual(['Bearer first-key', 'Bearer second-key']);
	expect(requests.every((request) => !request.headers.has('cookie'))).toBe(
		true,
	);
	expect(
		requests.every(
			(request) => request.url === 'https://models.example/v1/models',
		),
	).toBe(true);
});

test('credential rotation aborts admitted requests and refuses stale clients', async () => {
	let capturedSignal: AbortSignal | undefined;
	const { catalog } = await setup({
		fetch: (async (_input, init) => {
			capturedSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) =>
				capturedSignal!.addEventListener(
					'abort',
					() => reject(new Error('aborted')),
					{ once: true },
				),
			);
		}) as typeof globalThis.fetch,
	});
	const entry = await add(catalog, 'old-key');
	const pending = catalog.proxy(
		entry.id,
		entry.accessVersion,
		new Request('http://host/inference'),
		'models',
	);
	const refused = pending.catch((error) => error);
	await Promise.resolve();
	await Promise.resolve();
	await catalog.execute({
		type: 'update',
		id: entry.id,
		patch: { apiKey: 'new-key' },
	});
	expect((await refused).message).toBe('AI connection request failed.');
	expect(capturedSignal?.aborted).toBe(true);
	expect(catalog.getAll().connections[0]!.accessVersion).not.toBe(
		entry.accessVersion,
	);
	await expect(
		catalog.proxy(
			entry.id,
			entry.accessVersion,
			new Request('http://host/inference'),
			'models',
		),
	).rejects.toThrow('unavailable or changed');
});

test('missing referenced key fails without sending an anonymous request', async () => {
	let calls = 0;
	const memory = createProcessMemoryAppSecrets();
	const { catalog } = await setup({
		secrets: { ...memory, get: async () => null },
		fetch: (async (_input) => {
			calls++;
			return new Response();
		}) as typeof globalThis.fetch,
	});
	const entry = await add(catalog, 'secret');
	await expect(
		catalog.proxy(
			entry.id,
			entry.accessVersion,
			new Request('http://host/inference'),
			'models',
		),
	).rejects.toThrow();
	expect(calls).toBe(0);
});

test('failed keychain or metadata writes leave the saved catalog unchanged', async () => {
	const memory = createProcessMemoryAppSecrets();
	let deletes = 0;
	let failKey = true;
	const { catalog, dataRoot } = await setup({
		secrets: {
			...memory,
			async put(...args) {
				if (failKey) throw new Error('private-key-detail');
				await memory.put(...args);
			},
			async delete(...args) {
				deletes++;
				await memory.delete(...args);
			},
		},
	});
	await expect(add(catalog, 'secret')).rejects.toThrow(
		'Could not save AI connection credentials',
	);
	expect(catalog.getAll().connections).toEqual([]);
	failKey = false;
	await mkdir(join(dataRoot, 'ai/no-account/connections.json'));
	await expect(add(catalog, 'secret')).rejects.toThrow(
		'Could not save the AI catalog',
	);
	expect(catalog.getAll().revision).toBe(0);
	expect(deletes).toBe(1);
});

test('opening and editing retain version-1 records and inert import markers without reading keys', async () => {
	const { catalog, dataRoot, secrets } = await setup();
	const entry = await add(catalog, 'retained-key');
	await catalog.close();
	const path = join(dataRoot, 'ai/no-account/connections.json');
	const saved = JSON.parse(await readFile(path, 'utf8'));
	saved.imports = ['vocab:vocab'];
	const original = JSON.stringify(saved);
	await writeFile(path, original);
	let reads = 0;
	const reopened = await createAiCatalog({
		dataRoot,
		secrets: {
			...secrets,
			async get() {
				reads++;
				throw new Error('The keychain is unavailable.');
			},
		},
	});
	cleanup.push(() => reopened.close());
	expect(await readFile(path, 'utf8')).toBe(original);
	expect(reopened.getAll().connections).toEqual([entry]);
	await reopened.execute({
		type: 'update',
		id: entry.id,
		patch: { name: 'Renamed' },
	});
	expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
		...saved,
		revision: saved.revision + 1,
		connections: [{ ...saved.connections[0], name: 'Renamed' }],
	});
	expect(reads).toBe(0);
});

test('an obsolete import command is rejected without changing storage or touching credentials', async () => {
	let secretOperations = 0;
	const unexpected = async () => {
		secretOperations++;
		throw new Error('No credential operation is allowed.');
	};
	const { catalog, dataRoot } = await setup({
		secrets: { get: unexpected, put: unexpected, delete: unexpected },
	});
	await add(catalog);
	const path = join(dataRoot, 'ai/no-account/connections.json');
	const original = await readFile(path, 'utf8');
	const snapshot = catalog.getAll();
	const command = {
		type: 'import',
		source: 'vocab:vocab',
		records: [
			{
				id: 'legacy-id',
				baseUrl: 'https://models.example/v1',
				apiKey: 'old-key',
			},
		],
	};
	// Host routes accept JSON; the removed operation must also fail at runtime.
	// @ts-expect-error The import command is no longer part of the public API.
	await expect(catalog.execute(command)).rejects.toThrow(
		'Invalid AI catalog command',
	);
	expect(catalog.getAll()).toEqual(snapshot);
	expect(await readFile(path, 'utf8')).toBe(original);
	expect(secretOperations).toBe(0);
});

test('malformed saved metadata and endpoint credentials fail without exposing them', async () => {
	const { catalog, dataRoot, secrets } = await setup();
	await expect(
		catalog.execute({
			type: 'add',
			input: { baseUrl: 'https://user:secret@example.com/v1' },
		}),
	).rejects.toThrow('Invalid AI endpoint');
	await catalog.close();
	await writeFile(
		join(dataRoot, 'ai/no-account/connections.json'),
		'{"apiKey":"private"}',
	);
	await expect(createAiCatalog({ dataRoot, secrets })).rejects.toThrow(
		'Could not open the saved AI catalog',
	);
});

test('deletion cancels an unread response body and strips provider cookies', async () => {
	let cancellations = 0;
	const { catalog } = await setup({
		fetch: (async (_input) =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('first'));
					},
					cancel() {
						cancellations++;
					},
				}),
				{
					headers: {
						'set-cookie': 'provider=must-not-reach-host',
						'cache-control': 'public',
					},
				},
			)) as typeof globalThis.fetch,
	});
	const entry = await add(catalog);
	const response = await catalog.proxy(
		entry.id,
		entry.accessVersion,
		new Request('http://host/inference'),
		'chat/completions',
	);
	expect(response.headers.has('set-cookie')).toBe(false);
	expect(response.headers.get('cache-control')).toBe('no-store');
	await catalog.execute({ type: 'remove', id: entry.id });
	expect(cancellations).toBe(1);
	await expect(response.text()).rejects.toThrow('cancelled');
});

test('host close waits for upstream stream cancellation to finish', async () => {
	const cancelled = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { catalog } = await setup({
		fetch: (async (_input) =>
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled.resolve();
						return release.promise;
					},
				}),
			)) as typeof globalThis.fetch,
	});
	const entry = await add(catalog);
	await catalog.proxy(
		entry.id,
		entry.accessVersion,
		new Request('http://host/inference'),
		'chat/completions',
	);
	let closed = false;
	const closing = catalog.close().then(() => {
		closed = true;
	});
	await cancelled.promise;
	expect(closed).toBe(false);
	release.resolve();
	await closing;
	expect(closed).toBe(true);
	expect(() => catalog.getAll()).toThrow('closed');
});

test('a proxy request cannot escape its configured API prefix', async () => {
	let requests = 0;
	const { catalog } = await setup({
		fetch: (async (_input) => {
			requests++;
			return new Response('unexpected');
		}) as typeof globalThis.fetch,
	});
	const entry = await add(catalog, 'secret');
	for (const suffix of [
		'../outside',
		'https://other.example/v1/models',
		'//other.example/v1/models',
	]) {
		await expect(
			catalog.proxy(
				entry.id,
				entry.accessVersion,
				new Request('http://host/inference'),
				suffix,
			),
		).rejects.toThrow('request failed');
	}
	expect(requests).toBe(0);
});

test('metadata and destination edits preserve a missing credential reference without reading it', async () => {
	let reads = 0;
	const memory = createProcessMemoryAppSecrets();
	const { catalog, dataRoot } = await setup({
		secrets: {
			...memory,
			async get() {
				reads++;
				return null;
			},
		},
	});
	const entry = await add(catalog, 'lost-key');
	const original = JSON.parse(
		await readFile(join(dataRoot, 'ai/no-account/connections.json'), 'utf8'),
	).connections[0];
	await catalog.execute({
		type: 'update',
		id: entry.id,
		patch: { name: 'Renamed', models: ['manual'] },
	});
	expect(reads).toBe(0);
	expect(catalog.getAll().connections[0]!.accessVersion).toBe(
		entry.accessVersion,
	);
	await catalog.execute({
		type: 'update',
		id: entry.id,
		patch: { baseUrl: 'https://replacement.example/v1' },
	});
	expect(reads).toBe(0);
	const changed = catalog.getAll().connections[0]!;
	expect(changed.accessVersion).not.toBe(entry.accessVersion);
	expect(changed.hasApiKey).toBe(true);
	const persisted = JSON.parse(
		await readFile(join(dataRoot, 'ai/no-account/connections.json'), 'utf8'),
	).connections[0];
	expect(persisted.secretVersion).toBe(original.secretVersion);
	await expect(
		catalog.proxy(
			changed.id,
			changed.accessVersion,
			new Request('http://host/inference'),
			'models',
		),
	).rejects.toThrow('request failed');
	expect(reads).toBe(1);
});

test('explicit replacement and removal repair missing credentials without reading the old key', async () => {
	let reads = 0;
	const memory = createProcessMemoryAppSecrets();
	const { catalog } = await setup({
		secrets: {
			...memory,
			async get() {
				reads++;
				return null;
			},
		},
	});
	const entry = await add(catalog, 'lost-key');
	await catalog.execute({
		type: 'update',
		id: entry.id,
		patch: { apiKey: 'replacement' },
	});
	const replaced = catalog.getAll().connections[0]!;
	expect(replaced.hasApiKey).toBe(true);
	expect(replaced.accessVersion).not.toBe(entry.accessVersion);
	await catalog.execute({
		type: 'update',
		id: entry.id,
		patch: { apiKey: '' },
	});
	const cleared = catalog.getAll().connections[0]!;
	expect(cleared.hasApiKey).toBe(false);
	expect(cleared.accessVersion).not.toBe(replaced.accessVersion);
	expect(reads).toBe(0);
});

test('assigning the same explicit key creates new access without reading the old key', async () => {
	let reads = 0;
	const memory = createProcessMemoryAppSecrets();
	const { catalog } = await setup({
		secrets: {
			...memory,
			async get(...args) {
				reads++;
				return memory.get(...args);
			},
		},
	});
	const entry = await add(catalog, 'same-key');
	await catalog.execute({
		type: 'update',
		id: entry.id,
		patch: { apiKey: 'same-key' },
	});
	expect(catalog.getAll().connections[0]!.accessVersion).not.toBe(
		entry.accessVersion,
	);
	expect(reads).toBe(0);
});

test('a directory-sync failure retains old and newly committed keys after rename', async () => {
	const memory = createProcessMemoryAppSecrets();
	const stored = new Map<string, string>();
	const { catalog, dataRoot } = await setup({
		secrets: {
			...memory,
			async put(...args) {
				stored.set(args[1], args[2]);
				await memory.put(...args);
			},
			async delete(...args) {
				stored.delete(args[1]);
				await memory.delete(...args);
			},
		},
	});
	const entry = await add(catalog, 'old-key');
	const actualOpen = filesystem.open;
	let directorySyncs = 0;
	const interception = spyOn(filesystem, 'open').mockImplementation(
		async (...args) => {
			const handle = await actualOpen(...args);
			if (args[0] === join(dataRoot, 'ai', 'no-account')) {
				handle.sync = async () => {
					directorySyncs++;
					throw new Error('Directory sync unavailable');
				};
			}
			return handle;
		},
	);
	try {
		await catalog.execute({
			type: 'update',
			id: entry.id,
			patch: { apiKey: 'new-key' },
		});
	} finally {
		interception.mockRestore();
	}
	expect(directorySyncs).toBe(1);
	expect([...stored.values()].sort()).toEqual(['new-key', 'old-key']);
	const committed = JSON.parse(
		await readFile(join(dataRoot, 'ai/no-account/connections.json'), 'utf8'),
	).connections[0];
	expect(committed.accessVersion).toBe(
		catalog.getAll().connections[0]!.accessVersion,
	);
	expect(committed.accessVersion).not.toBe(entry.accessVersion);
	expect(committed.secretVersion).toBe(committed.accessVersion);
});
