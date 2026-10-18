import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { defineFolder, defineTable, field, openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	rawBrowserFolder,
} from './browser-storage.test-support.js';
import type { GitBackend } from './git/backend.js';
import { createHistory } from './git/history.js';
import { abortableHttp, type HttpFetch } from './git/http.js';
import {
	createBareRemote,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';

test('a folder routes only its Git requests through the injected transport and keeps its canonical remote', async () => {
	const root = await scratch('folder-git-transport-');
	const bare = await createBareRemote(root);
	const serveGit = await gitHttpFetch(root);
	const canonical = 'https://github.com/example/private-data.git';
	const requests: Request[] = [];
	const originalFetch = globalThis.fetch;
	const httpFetch: HttpFetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		const url = new URL(request.url);
		expect(url.origin + '/example/private-data.git').toBe(canonical);
		const target = `http://git.test/remote.git${url.pathname.slice('/example/private-data.git'.length)}${url.search}`;
		return serveGit(new Request(target, request));
	};
	const definition = defineFolder({
		tables: {
			settings: defineTable({
				fields: { language: field.optional(field.string()) },
			}),
		},
	});
	const open = () =>
		openFolder({
			app: 'com.example.transport',
			definition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				httpFetch,
				...browserStorage(createTestStorage()),
			},
		});
	const sender = expectOk(await open());
	const receiver = expectOk(await open());
	try {
		expectOk(
			await sender.tables.settings.create(
				{ fields: { language: 'Chinese' }, body: '' },
				{ stem: 'display' },
			),
		);
		expect(expectOk(await sender.sync.connect(canonical)).kind).toBe('synced');
		const remoteHead = await git(bare, 'rev-parse', 'main');
		expect(expectOk(await receiver.sync.connect(canonical))).toEqual({
			kind: 'synced',
			head: remoteHead,
		});
		expect(
			expectOk(await receiver.tables.settings.get('display'))?.row.fields
				.language,
		).toBe('Chinese');
		expect(receiver.git.snapshot.remote).toEqual({
			url: canonical,
			branch: 'main',
		});
		expect(
			requests.some((request) => request.url.endsWith('/git-receive-pack')),
		).toBe(true);
		expect(
			requests.some((request) => request.url.endsWith('/git-upload-pack')),
		).toBe(true);
		expect(globalThis.fetch).toBe(originalFetch);
	} finally {
		await sender.close();
		await receiver.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('the injected Git transport receives cancellation', async () => {
	const controller = new AbortController();
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const httpFetch: HttpFetch = async (_input, init) => {
		expect(init?.signal).toBe(controller.signal);
		entered();
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener(
				'abort',
				() => reject(init.signal?.reason),
				{ once: true },
			);
		});
	};
	const transfer = abortableHttp(
		controller.signal,
		httpFetch,
	)('https://example.test/data.git/info/refs');
	await started;
	controller.abort(new Error('Folder closed'));
	await expect(transfer).rejects.toThrow('Folder closed');
});

test('a Sync that takes a fetched history loads its pack once for all the files it lands', async () => {
	const root = await scratch('folder-git-pack-loads-');
	const bare = await createBareRemote(root);
	const native = join(root, 'native');
	await git(root, 'init', '--quiet', '--initial-branch=main', native);
	const FILES = 30;
	for (let index = 0; index < FILES; index++) {
		await mkdir(join(native, `notes-${index}`));
		await writeFile(join(native, `notes-${index}/a.txt`), `${index}\n`);
	}
	await git(native, 'add', '.');
	await git(native, 'commit', '--quiet', '-m', 'Many files');
	await git(native, 'push', '--quiet', bare, 'main');

	const raw = await rawBrowserFolder({ id: 'pack-loads' });
	const real = await raw.backend({ httpFetch: await gitHttpFetch(root) });
	// Pack index reads, by the cache of the operation that made them, and
	// how many object calls each cache served.
	const loads = new Map<object, number>();
	const calls = new Map<object, number>();
	const backend: GitBackend = {
		...real,
		withObjects(work, cache = {}) {
			calls.set(cache, (calls.get(cache) ?? 0) + 1);
			return real.withObjects((access) => {
				const promises = access.fs.promises;
				const readFile = async (path?: string, options?: unknown) => {
					if (path?.endsWith('.idx'))
						loads.set(cache, (loads.get(cache) ?? 0) + 1);
					return promises.readFile(path, options);
				};
				return work({ ...access, fs: { promises: { ...promises, readFile } } });
			}, cache);
		},
	};
	const history = createHistory({
		backend,
		boundary: raw.boundary,
		author: { name: 'Test', email: 'test@example.test' },
	});
	try {
		expect(
			expectOk(await history.sync.connect('http://git.test/remote.git')),
		).toEqual({ kind: 'synced', head: await git(bare, 'rev-parse', 'main') });
		expect(expectOk(await history.status()).changes).toEqual([]);
		// The Sync landed every file through one cache, which read the
		// fetched pack's index once; no cache read it twice, so the pack was
		// loaded once per operation, never once per file.
		const total = [...loads.values()].reduce((sum, count) => sum + count, 0);
		expect(Math.max(...calls.values())).toBeGreaterThan(FILES);
		expect(Math.max(...loads.values())).toBe(1);
		expect(total).toBeLessThan(FILES / 3);
	} finally {
		await history.close();
		await rm(root, { recursive: true, force: true });
	}
});
