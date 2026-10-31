/**
 * Messages' local program: it serves the built page, and answers Beeper
 * operations only to that page.
 *
 * Key behaviors:
 * - Files of the build are served, any other route gets the app's page, and
 *   no path reaches outside the build
 * - A Beeper operation from the page's own origin, naming the server's own
 *   host, as JSON, is answered; anything else is refused before it is read
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BeeperAnswer } from '@epicenter/cli/messages-protocol';
import { serveMessages } from './serve.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((step) => step()));
});

async function start() {
	const root = await mkdtemp(join(tmpdir(), 'messages-serve-'));
	await writeFile(join(root, 'index.html'), '<p>Messages</p>');
	await writeFile(join(root, 'contract.json'), '{"name":"messages"}');
	const asked: unknown[] = [];
	const server = serveMessages({
		root,
		port: 0,
		async answer(input) {
			asked.push(input);
			return { kind: 'connected', profile: 'fake' } satisfies BeeperAnswer;
		},
	});
	cleanup.push(async () => {
		await server.stop(true);
		await rm(root, { recursive: true, force: true });
	});
	const origin = `http://127.0.0.1:${server.port}`;
	return { origin, asked };
}

test('the build is served, any other route gets the app, and nothing outside the build is reachable', async () => {
	const { origin } = await start();
	expect(await (await fetch(`${origin}/`)).text()).toBe('<p>Messages</p>');
	expect(await (await fetch(`${origin}/contract.json`)).json()).toEqual({
		name: 'messages',
	});
	expect(await (await fetch(`${origin}/chats/anything`)).text()).toBe(
		'<p>Messages</p>',
	);
	expect(await (await fetch(`${origin}/%2e%2e/%2e%2e/etc/hosts`)).text()).toBe(
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
