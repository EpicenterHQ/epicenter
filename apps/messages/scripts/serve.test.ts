/**
 * Messages' local program: it serves the built page, and answers Beeper
 * operations and its drafts' directory only to that page.
 *
 * Key behaviors:
 * - Files of the build are served, any other route gets the app's page, and
 *   no path reaches outside the build
 * - A Beeper operation from the page's own origin, naming the server's own
 *   host, as JSON, is answered; anything else is refused before it is read
 * - The drafts' directory answers the page the same way, and nothing else
 * - The drafts live in Messages' own directory under Epicenter's
 *   application data, never under `~/Epicenter`
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BeeperAnswer } from '../src/lib/beeper-protocol.ts';
import { messagesFolder, serveMessages } from './serve.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((step) => step()));
});

async function start() {
	const root = await mkdtemp(join(tmpdir(), 'messages-serve-'));
	await writeFile(join(root, 'index.html'), '<p>Messages</p>');
	const outside = `${root}-outside.txt`;
	await writeFile(outside, 'outside the build');
	await writeFile(
		join(root, 'contract.json'),
		'{"collections":{"messages":{"path":"messages/{id}.md"}}}',
	);
	const folder = await mkdtemp(join(tmpdir(), 'messages-folder-'));
	const asked: unknown[] = [];
	const server = serveMessages({
		root,
		folder,
		port: 0,
		async answer(input) {
			asked.push(input);
			return { kind: 'connected', profile: 'fake' } satisfies BeeperAnswer;
		},
	});
	cleanup.push(async () => {
		await server.stop();
		await rm(root, { recursive: true, force: true });
		await rm(outside, { force: true });
		await rm(folder, { recursive: true, force: true });
	});
	const origin = `http://127.0.0.1:${server.port}`;
	return { origin, asked, folder, outside: basename(outside) };
}

test('the build is served, any other route gets the app, and nothing outside the build is reachable', async () => {
	const { origin, outside } = await start();
	expect(await (await fetch(`${origin}/`)).text()).toBe('<p>Messages</p>');
	expect(await (await fetch(`${origin}/contract.json`)).json()).toEqual({
		collections: { messages: { path: 'messages/{id}.md' } },
	});
	expect(await (await fetch(`${origin}/chats/anything`)).text()).toBe(
		'<p>Messages</p>',
	);
	// Encoded slashes survive URL normalization, so this reaches the server's
	// path guard and would serve the sibling file if that guard were removed.
	expect(await (await fetch(`${origin}/%2e%2e%2f${outside}`)).text()).toBe(
		'<p>Messages</p>',
	);
	expect((await fetch(`${origin}/`, { method: 'DELETE' })).status).toBe(405);
});

test('a Beeper operation from the page is answered', async () => {
	const { origin, asked } = await start();
	const answered = await fetch(`${origin}/beeper`, {
		method: 'POST',
		headers: { origin, 'content-type': 'application/json' },
		body: JSON.stringify({ action: 'connect' }),
	});
	expect(await answered.json()).toEqual({ kind: 'connected', profile: 'fake' });
	expect(asked).toEqual([{ action: 'connect' }]);
});

test('a Beeper operation from anywhere else is refused unread', async () => {
	const { origin, asked } = await start();
	const ask = (headers: Record<string, string>, method = 'POST') =>
		fetch(`${origin}/beeper`, {
			method,
			headers,
			...(method === 'POST' ? { body: '{"action":"chats"}' } : {}),
		});
	const json = { 'content-type': 'application/json' };
	expect((await ask(json)).status).toBe(403);
	expect(
		(await ask({ ...json, origin: 'https://elsewhere.example' })).status,
	).toBe(403);
	expect((await ask({ origin, 'content-type': 'text/plain' })).status).toBe(
		403,
	);
	expect(
		(
			await ask({
				...json,
				origin,
				host: `rebound.example:${new URL(origin).port}`,
			})
		).status,
	).toBe(403);
	expect((await ask({ origin }, 'GET')).status).toBe(405);
	expect(asked).toEqual([]);
});

test('the drafts’ directory answers the page, and only the page', async () => {
	const { origin, folder } = await start();
	const json = { 'content-type': 'application/json' };
	const write = (headers: Record<string, string>) =>
		fetch(`${origin}/folder/put`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				path: 'drafts/a.md',
				bytes: btoa('---\nchatId: c\n---\nHi'),
				expect: null,
			}),
		});
	expect((await write(json)).status).toBe(403);
	expect(
		(await write({ ...json, origin: 'https://elsewhere.example' })).status,
	).toBe(403);
	expect((await fetch(`${origin}/folder/list`)).status).toBe(405);
	expect(
		await readFile(join(folder, 'drafts/a.md'), 'utf8').catch(() => null),
	).toBeNull();

	const landed = await write({ ...json, origin });
	expect(landed.status).toBe(200);
	expect(await readFile(join(folder, 'drafts/a.md'), 'utf8')).toBe(
		'---\nchatId: c\n---\nHi',
	);
});

test('the drafts live in Messages’ own directory under Epicenter’s application data', () => {
	const saved = process.env.EPICENTER_DATA_DIR;
	process.env.EPICENTER_DATA_DIR = '/data/epicenter';
	try {
		expect(messagesFolder()).toBe('/data/epicenter/apps/so.epicenter.messages');
	} finally {
		if (saved === undefined) delete process.env.EPICENTER_DATA_DIR;
		else process.env.EPICENTER_DATA_DIR = saved;
	}
	const development = messagesFolder('development');
	if (saved === undefined && process.platform === 'darwin')
		expect(development).toEndWith(
			'/Library/Application Support/so.epicenter.dev/apps/so.epicenter.messages',
		);
	expect(development).not.toContain('/Epicenter/');
});
