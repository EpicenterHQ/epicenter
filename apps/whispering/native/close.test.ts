/**
 * The close handshake between the shell and the page, as the host carries it.
 *
 * The shell asks before closing, and the host approves only on the page's
 * explicit `proceed`. Silence, slowness, and a dropped connection are never
 * approval, because the page still holds its unsaved work through all of them.
 * These drive the real host over its real request handler, without the shell:
 * a close request is what the shell writes to the host's standard input, and
 * an approval is the line the host prints.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpBridge } from '../src/lib/bridge/http.js';
import { createHost, type Host } from './host.js';

const TOKEN = 'test-token';
const ORIGIN = 'http://127.0.0.1:4999';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start() {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-close-')),
	);
	let approvals = 0;
	const root = join(directory, 'data');
	await mkdir(root);
	const host = await createHost({
		root,
		token: TOKEN,
		uiDist: undefined,
		debug: false,
		fixturePath: undefined,
		env: {},
		log: () => {},
		onCloseApproved: () => {
			approvals += 1;
		},
	});
	host.listening(4999);
	cleanups.push(async () => {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	});
	return {
		host,
		answer: (decision: string) =>
			createHttpBridge({
				origin: ORIGIN,
				token: TOKEN,
				fetch: (input, init) => host.handle(new Request(input, init)),
			}).app('close', { decision }),
		get approvals() {
			return approvals;
		},
	};
}

/** A page's event stream: the types of the events it has received so far. */
async function connect(host: Host) {
	const response = await host.handle(
		new Request(`${ORIGIN}/bridge/events`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		}),
	);
	const reader = response.body!.getReader();
	const types: string[] = [];
	const decoder = new TextDecoder();
	let open = true;
	void (async () => {
		let pending = '';
		while (open) {
			const { done, value } = await reader.read().catch(() => ({
				done: true as const,
				value: undefined,
			}));
			if (done) return;
			pending += decoder.decode(value, { stream: true });
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines)
				if (line.trim() !== '') types.push(JSON.parse(line).type);
		}
	})();
	const disconnect = async () => {
		open = false;
		await reader.cancel().catch(() => {});
	};
	cleanups.push(disconnect);
	await settle();
	return {
		disconnect,
		get closeRequests() {
			return types.filter((type) => type === 'close-requested').length;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a close asked before any event stream connected waits, and is delivered on connect', async () => {
	const started = await start();

	// A page can be recording and saving to the folder while its
	// event stream has not connected, so no stream is not "nothing held".
	started.host.closeRequested();
	started.host.closeRequested();
	await settle();
	expect(started.approvals).toBe(0);

	const page = await connect(started.host);
	expect(page.closeRequests).toBe(1);
	expect(started.approvals).toBe(0);

	await started.answer('proceed');
	expect(started.approvals).toBe(1);
});

test('a page that never opened a stream can still approve its own close', async () => {
	const started = await start();
	started.host.closeRequested();
	await settle();
	expect(started.approvals).toBe(0);

	// The answer is an ordinary authenticated call; it needs no event stream.
	await started.answer('proceed');
	expect(started.approvals).toBe(1);
});

test('a connected page is asked, and nothing closes until it answers', async () => {
	const started = await start();
	const page = await connect(started.host);

	started.host.closeRequested();
	await settle();

	expect(page.closeRequests).toBe(1);
	expect(started.approvals).toBe(0);
});

test('only the page answering proceed approves the close', async () => {
	const started = await start();
	await connect(started.host);
	started.host.closeRequested();
	await settle();

	await started.answer('asking');
	expect(started.approvals).toBe(0);
	await started.answer('proceed');
	expect(started.approvals).toBe(1);
});

test('a page that never answers is never closed, however often the shell asks', async () => {
	const started = await start();
	const page = await connect(started.host);

	for (let attempt = 0; attempt < 5; attempt++) {
		started.host.closeRequested();
		await settle();
	}

	expect(started.approvals).toBe(0);
	expect(page.closeRequests).toBe(5);
});

test('a cancelled close stays open, and the next request asks again', async () => {
	const started = await start();
	const page = await connect(started.host);
	started.host.closeRequested();
	await settle();
	await started.answer('asking');
	await started.answer('cancel');

	started.host.closeRequested();
	await settle();

	expect(started.approvals).toBe(0);
	expect(page.closeRequests).toBe(2);
});

test('a page whose connection dropped is still asked, when it reconnects', async () => {
	const started = await start();
	const first = await connect(started.host);
	await first.disconnect();
	await settle();

	// No stream is open, but a page exists and holds whatever it held.
	started.host.closeRequested();
	await settle();
	expect(started.approvals).toBe(0);

	const again = await connect(started.host);
	expect(again.closeRequests).toBe(1);
	expect(started.approvals).toBe(0);

	// Once answered, a later reconnect is not asked again.
	await started.answer('cancel');
	const later = await connect(started.host);
	expect(later.closeRequests).toBe(0);
});

test('a close answer must be one of the three decisions, and needs the token', async () => {
	const started = await start();
	await connect(started.host);
	await expect(started.answer('maybe')).rejects.toThrow();
	expect(started.approvals).toBe(0);

	const unauthorized = await started.host.handle(
		new Request(`${ORIGIN}/bridge/app`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'close', payload: { decision: 'proceed' } }),
		}),
	);
	expect(unauthorized.status).toBe(401);
	expect(started.approvals).toBe(0);
});
