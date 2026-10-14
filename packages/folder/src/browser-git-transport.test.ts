import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { expectOk } from 'wellcrafted/testing';
import { defineFolder, field, openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
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
		kv: { language: field.string() },
		tables: {},
	});
	const open = () =>
		openFolder({
			id: 'com.example.transport',
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
		expectOk(await sender.kv.set('language', 'Chinese'));
		expect(expectOk(await sender.sync.connect(canonical)).kind).toBe('synced');
		const remoteHead = await git(bare, 'rev-parse', 'main');
		expect(expectOk(await receiver.sync.connect(canonical))).toEqual({
			kind: 'synced',
			head: remoteHead,
		});
		expect(expectOk(await receiver.kv.get())?.values.language).toBe('Chinese');
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
	const transfer = abortableHttp(controller.signal, httpFetch).request({
		url: 'https://example.test/data.git/info/refs',
	});
	await started;
	controller.abort(new Error('Folder closed'));
	await expect(transfer).rejects.toThrow('Folder closed');
});
