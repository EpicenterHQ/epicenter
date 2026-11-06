/**
 * A directory a program serves its page, beyond the store conformance
 * checks (`store.conformance.test.ts` runs those over it).
 *
 * Key behaviors:
 * - A folder opens at a served directory and writes its files there
 * - A page something else served fails to open, saying so; a program out of reach keeps it opening
 * - A dropped watch is heard as `'all'`, and again once the program answers
 * - The program stops a watch when its page goes away
 * - A request the program cannot read is refused unread
 */
import { afterEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { memoryStore } from '../device/memory-store.js';
import { scratch } from '../git.test-support.js';
import { openFolder } from '../open-folder.js';
import { serveDirectory } from '../serve.js';
import { served } from '../served.js';
import { storeHandler } from './handler.js';
import { servedStore } from './store.js';

const notes = defineContract({
	description: 'Notes, for a test.',
	collections: {
		notes: {
			path: 'notes/{id}.md',
			fields: { title: { type: 'string' } },
			required: ['title'],
		},
	},
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** A program serving a new directory at `/folder`, on `port` (any free one by default). */
async function program(root?: string, port = 0) {
	const directory = root ?? (await scratch('served-'));
	if (root === undefined)
		cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const handler = serveDirectory(directory);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch(request) {
			if (new URL(request.url).pathname.startsWith('/folder/'))
				return handler.fetch(request);
			return new Response('<p>a page</p>', {
				headers: { 'content-type': 'text/html' },
			});
		},
	});
	const stop = async () => {
		handler.close();
		await server.stop(true);
	};
	cleanup.push(stop);
	return {
		root: directory,
		url: `http://127.0.0.1:${server.port}`,
		port: server.port,
		stop,
	};
}

test('a folder opens at a served directory and writes its files there', async () => {
	const { root, url } = await program();
	const folder = openFolder(notes, served(`${url}/folder`));
	cleanup.push(() => folder[Symbol.dispose]());
	await folder.notes.set({ id: 'a' }, { title: 'One', body: 'Hello' });
	expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe(
		'---\ntitle: One\n---\nHello',
	);
	expect(folder.notes.get({ id: 'a' })?.title).toBe('One');
});

test('a page something else served fails to open, saying so', async () => {
	const { url } = await program();
	const folder = openFolder(notes, served(`${url}/elsewhere`));
	cleanup.push(() => folder[Symbol.dispose]());
	const listed = await folder.notes.list();
	expect(listed.error?.name).toBe('StorageUnavailable');
	expect(folder.state().status).toBe('failed');
});

test('a program out of reach keeps the folder opening', async () => {
	const { url, stop } = await program();
	await stop();
	const folder = openFolder(notes, served(`${url}/folder`));
	cleanup.push(() => folder[Symbol.dispose]());
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(folder.state().status).toBe('opening');
	expect(folder.unavailable()?.name).toBe('Unavailable');
});

test('a dropped watch is heard as all, and again once the program answers', async () => {
	const first = await program();
	const store = servedStore(`${first.url}/folder`, { retryMs: 50 });
	cleanup.push(() => store.close());
	const heard: (readonly string[] | 'all')[] = [];
	const watched = await store.watch((paths) => heard.push(paths));
	expect(watched.error).toBeNull();
	await first.stop();
	await until(() => heard.includes('all'));
	expect(heard).toEqual(['all']);
	await program(first.root, first.port);
	await until(() => heard.length === 2);
	expect(heard).toEqual(['all', 'all']);
	watched.data?.();
});

test('the program stops a watch when its page goes away', async () => {
	const store = memoryStore();
	let watching = 0;
	const handler = storeHandler(async () =>
		Ok({
			...store,
			async watch(changed) {
				const watched = await store.watch(changed);
				if (watched.error !== null) return watched;
				watching++;
				return Ok(() => {
					watching--;
					watched.data();
				});
			},
		}),
	);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: handler.fetch,
	});
	cleanup.push(() => server.stop(true));
	const page = servedStore(`http://127.0.0.1:${server.port}/folder`);
	const watched = await page.watch(() => {});
	expect(watching).toBe(1);
	watched.data?.();
	await until(() => watching === 0);
	expect(watching).toBe(0);
	await page.watch(() => {});
	expect(watching).toBe(1);
	handler.close();
	expect(watching).toBe(0);
	page.close();
});

test('a request the program cannot read is refused unread', async () => {
	const { url } = await program();
	const post = (verb: string, body: string) =>
		fetch(`${url}/folder/${verb}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		});
	expect((await post('list', 'not json')).status).toBe(400);
	expect((await post('list', '{"under":"notes"}')).status).toBe(400);
	expect(
		(await post('put', '{"path":"a.md","bytes":"%%","expect":null}')).status,
	).toBe(400);
	expect((await post('rename', '{}')).status).toBe(404);
	expect((await fetch(`${url}/folder/list`)).status).toBe(405);
});

async function until(done: () => boolean, ms = 3000) {
	const end = Date.now() + ms;
	while (!done() && Date.now() < end)
		await new Promise((resolve) => setTimeout(resolve, 10));
}
