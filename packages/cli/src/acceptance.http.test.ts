/**
 * HTTP serve acceptance tests.
 * Runs the real CLI against a temporary HOME and checks MCP calls, the
 * snapshots after them and of quiet outside edits, UI confinement, and
 * request origin handling.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActionError, connect } from '@epicenter/app/client';
import { fixture, gitIn, readingApp } from './runner.test-support.ts';

/** Reading's actions as its UI calls them, for `connect`. */
type Reading = {
	actions: {
		log: (input: { minutes: number; book?: string }) => {
			minutes: number;
			book: string | null;
		};
		week: { show: () => number };
		explode: () => never;
	};
};

setDefaultTimeout(30_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(agents?: string, env: Record<string, string> = {}) {
	const f = await fixture();
	if (agents !== undefined) await writeFile(join(f.home, 'AGENTS.md'), agents);
	const child = Bun.spawn([process.execPath, f.bin, 'serve', '--port', '0'], {
		cwd: f.root,
		env: { ...f.env, ...env },
		stdout: 'ignore',
		stderr: 'pipe',
	});
	const ready = Promise.withResolvers<string>();
	let output = '';
	void (async () => {
		const reader = child.stderr.getReader();
		for (;;) {
			const { value: chunk, done } = await reader.read();
			if (done) break;
			output += new TextDecoder().decode(chunk);
			const port = /Serving your apps at http:\/\/127\.0\.0\.1:(\d+)\./.exec(
				output,
			)?.[1];
			if (port) ready.resolve(`http://127.0.0.1:${port}`);
		}
		ready.reject(new Error(output || 'serve exited before listening'));
	})();
	cleanups.push(async () => {
		child.kill('SIGTERM');
		await child.exited;
		await rm(f.root, { recursive: true, force: true });
	});
	const base = await Promise.race([
		ready.promise,
		Bun.sleep(10_000).then(() => {
			throw new Error('serve did not listen');
		}),
	]);
	return { ...f, base, stderr: () => output };
}

function mcp(base: string, method: string, params: object = {}) {
	return fetch(`${base}/`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
}

test('HTTP initialize includes the Epicenter AGENTS.md', async () => {
	const f = await setup('Use these apps through their actions.\n');
	const response = await mcp(f.base, 'initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'test', version: '1' },
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as { result: { instructions?: string } };
	expect(body.result.instructions).toBe(
		'Use these apps through their actions.\n',
	);
});

test('HTTP tools/list offers app actions', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), readingApp);
	const response = await mcp(f.base, 'tools/list');
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		result: { tools: { name: string }[] };
	};
	expect(body.result.tools.map((tool) => tool.name)).toEqual([
		'reading_books_list',
		'reading_books_get',
		'reading_books_add',
		'reading_books_set',
		'reading_books_edit',
		'reading_books_delete',
		'reading_log',
		'reading_between',
		'reading_week_show',
		'reading_explode',
	]);
});

test('a crafted tool name cannot run an app outside the home', async () => {
	const f = await setup();
	const outside = await f.app(
		'outside',
		`export default defineApp({ description: 'Outside', collections: {}, actions: { run: defineAction({ description: 'Run', input: {}, run: async () => { await folder.write('ran.txt', 'yes'); return true; } }) } });`,
		f.root,
	);
	const response = await mcp(f.base, 'tools/call', {
		name: `${outside}_run`,
		arguments: {},
	});
	const body = (await response.json()) as { result: { isError?: boolean } };
	expect(body.result.isError).toBe(true);
	expect(await Bun.file(join(outside, 'ran.txt')).exists()).toBe(false);
});

test('the browser client calls a tool without initialize and a write makes one named commit', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const client = connect<Reading>('reading', {
		url: `${f.base}/`,
	});
	expect(await client.log({ minutes: 30 })).toEqual({
		minutes: 30,
		book: null,
	});
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('2');
	expect(await gitIn(folder, 'log', '-1', '--format=%s')).toBe(
		'reading: log 30',
	);
	expect(await readFile(join(folder, '2026.csv'), 'utf8')).toBe(
		'minutes,book\n30,\n',
	);
});

test('a read-only action makes no commit, and one that throws after writing is snapshotted under its call', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const client = connect<Reading>('reading', { url: `${f.base}/` });
	await writeFile(join(folder, 'notes.md'), 'by hand\n');
	expect(await client.week.show()).toBe(210);
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
	const threw = await client.explode().catch((error: unknown) => error);
	expect(threw).toBeInstanceOf(ActionError);
	expect((threw as ActionError).message).toBe('line 4 is not a number');
	expect((threw as ActionError).answer).toEqual({
		threw: { message: 'line 4 is not a number' },
	});
	expect(await gitIn(folder, 'log', '-1', '--format=%B')).toBe(
		'reading: explode\n\nAlso changed:\nnotes.md',
	);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
});

test('a call whose snapshot fails still resolves, and the app says why', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	await writeFile(
		join(folder, '.gitattributes'),
		'*.csv filter=lfs diff=lfs merge=lfs -text\n',
	);
	const client = connect<Reading>('reading', { url: `${f.base}/` });
	expect(await client.log({ minutes: 5 })).toEqual({ minutes: 5, book: null });
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
	expect(JSON.parse((await f.run('reading', '--json')).stdout).status).toEqual({
		pending: 2,
		backup: 'none',
	});
});

test('concurrent writes through update both land, and both are in history', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const client = connect<Reading>('reading', { url: `${f.base}/` });
	await Promise.all([client.log({ minutes: 10 }), client.log({ minutes: 20 })]);
	expect(await readFile(join(folder, '2026.csv'), 'utf8')).toMatch(
		/^minutes,book\n(?:10,\n20,|20,\n10,)\n$/,
	);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
	const history = await gitIn(folder, 'log', '--format=%s');
	expect(history).toMatch(/reading: log (10|20)/);
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toMatch(/^[23]$/);
});

test('outside edits that have gone quiet are snapshotted and pushed within two checks', async () => {
	const f = await setup(undefined, { EPICENTER_QUIET_CHECK_MS: '300' });
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const remote = join(f.root, 'remote.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(folder, 'remote', 'add', 'origin', remote);
	await gitIn(folder, 'push', '-q', '-u', 'origin', 'HEAD');
	await writeFile(join(folder, 'notes.md'), 'by hand\n');
	const wrote = Date.now();
	let message = '';
	while (Date.now() - wrote < 5_000) {
		message = await gitIn(remote, 'log', '-1', '--format=%B');
		if (message !== 'initial') break;
		await Bun.sleep(50);
	}
	expect(message).toBe(
		'reading: changed outside epicenter\n\nChanged:\nnotes.md',
	);
	// Two checks 300 ms apart, then the snapshot and push; the bound leaves room for a loaded machine.
	expect(Date.now() - wrote).toBeLessThan(4_000);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
});

test('quiet check waits while a pending file keeps changing', async () => {
	const f = await setup(undefined, { EPICENTER_QUIET_CHECK_MS: '100' });
	const vault = await f.folder(
		join(f.root, 'vault'),
		Object.fromEntries(
			Object.entries(readingApp).map(([path, text]) => [
				`reading/${path}`,
				text,
			]),
		),
	);
	const folder = join(vault, 'reading');
	await symlink(folder, join(f.home, 'reading'));
	const path = join(folder, 'notes.md');
	for (let change = 0; change < 15; change++) {
		await writeFile(path, 'x'.repeat(change + 1));
		await Bun.sleep(75);
	}
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
	for (let attempt = 0; attempt < 40; attempt++) {
		if ((await gitIn(folder, 'rev-list', '--count', 'HEAD')) === '2') break;
		await Bun.sleep(75);
	}
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('2');
});

test('quiet check logs an unchanged snapshot failure once', async () => {
	const f = await setup(undefined, { EPICENTER_QUIET_CHECK_MS: '100' });
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	await writeFile(
		join(folder, '.gitattributes'),
		'*.csv filter=lfs diff=lfs merge=lfs -text\n',
	);
	await writeFile(join(folder, 'notes.md'), 'by hand\n');
	await Bun.sleep(700);
	expect(f.stderr().match(/not yet in history:/g)).toHaveLength(1);
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
});

test('serve reports a refused backup push and leaves both histories intact', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const remote = join(f.root, 'remote.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(folder, 'remote', 'add', 'origin', remote);
	await gitIn(folder, 'push', '-q', '-u', 'origin', 'HEAD');
	const peer = join(f.root, 'peer');
	await gitIn(f.root, 'clone', '-q', remote, peer);
	await writeFile(join(peer, 'peer.md'), 'from peer\n');
	await gitIn(peer, 'add', 'peer.md');
	await gitIn(peer, 'commit', '-q', '-m', 'peer');
	await gitIn(peer, 'push', '-q');
	await connect<Reading>('reading', { url: `${f.base}/` }).log({ minutes: 42 });
	for (
		let attempt = 0;
		attempt < 100 && !f.stderr().includes('nothing was overwritten');
		attempt++
	)
		await Bun.sleep(50);
	expect(f.stderr()).toContain(
		'the backup at origin has changes this computer does not; nothing was overwritten',
	);
	const branch = await gitIn(folder, 'symbolic-ref', '--short', 'HEAD');
	expect(f.stderr()).toContain(
		`git -C ${folder} fetch origin && git -C ${folder} log HEAD..origin/${branch}`,
	);
	expect(await gitIn(remote, 'log', '-1', '--format=%s')).toBe('peer');
	expect(await gitIn(folder, 'log', '-1', '--format=%s')).toBe(
		'reading: log 42',
	);
});

test('a successful write pushes to an upstream in the background', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const remote = join(f.root, 'remote.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(folder, 'remote', 'add', 'origin', remote);
	await gitIn(folder, 'push', '-q', '-u', 'origin', 'HEAD');
	await connect<Reading>('reading', {
		url: `${f.base}/`,
	}).log({ minutes: 42 });
	let subject = '';
	for (let attempt = 0; attempt < 50; attempt++) {
		subject = await gitIn(remote, 'log', '-1', '--format=%s');
		if (subject === 'reading: log 42') break;
		await Bun.sleep(50);
	}
	expect(subject).toBe('reading: log 42');
});

test('commit subjects use the first positional value on one line, capped at 60 characters', async () => {
	const f = await setup();
	const folder = await f.app(
		'notes',
		`export default defineApp({ description: 'The notes app', collections: {}, actions: {
		add: defineAction({ description: 'Add a note', input: { text: field.text() }, positional: ['text'],
			run: async ({ text }) => { await folder.write('note.txt', text); return text; } }),
	} });`,
	);
	const text = `Fear is the mind-killer ${'x'.repeat(80)}\nsecond line`;
	await connect<{ actions: { add: (input: { text: string }) => string } }>(
		'notes',
		{
			url: `${f.base}/`,
		},
	).add({ text });
	expect(await gitIn(folder, 'log', '-1', '--format=%B')).toBe(
		`notes: add ${text.replace(/\s+/g, ' ').slice(0, 60)}`,
	);
});

test('a built UI serves files and refuses traversal and symlinks outside it', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	await mkdir(join(folder, 'ui', 'dist', '_app', 'immutable'), {
		recursive: true,
	});
	await writeFile(
		join(folder, 'ui', 'dist', 'index.html'),
		'<h1>Reading</h1>',
	);
	await writeFile(
		join(folder, 'ui', 'dist', '_app', 'immutable', 'asset.js'),
		'export {};',
	);
	await symlink(
		join(folder, 'epicenter.ts'),
		join(folder, 'ui', 'dist', 'outside.ts'),
	);
	const linked = await f.app(
		'linked',
		`export default defineApp({ description: 'Linked UI', collections: {}, actions: {} });\n`,
	);
	const outsideUi = join(f.root, 'outside-ui');
	await mkdir(outsideUi);
	await writeFile(join(outsideUi, 'index.html'), 'outside');
	await mkdir(join(linked, 'ui'));
	await symlink(outsideUi, join(linked, 'ui', 'dist'));
	expect(await (await fetch(`${f.base}/`)).text()).toContain(
		'href="/reading/"',
	);
	expect(await (await fetch(`${f.base}/`)).text()).not.toContain(
		'href="/linked/"',
	);
	const redirect = await fetch(`${f.base}/reading`, { redirect: 'manual' });
	expect(redirect.status).toBe(308);
	expect(redirect.headers.get('location')).toBe('/reading/');
	expect(await (await fetch(`${f.base}/reading/`)).text()).toBe(
		'<h1>Reading</h1>',
	);
	expect((await fetch(`${f.base}/reading/`)).headers.get('cache-control')).toBe(
		'no-cache',
	);
	expect(
		(await fetch(`${f.base}/reading/_app/immutable/asset.js`)).headers.get(
			'cache-control',
		),
	).toBe('public, max-age=31536000, immutable');
	for (const path of [
		'../epicenter.ts',
		'%2e%2e/epicenter.ts',
		'%2e%2e%2fepicenter.ts',
		'outside.ts',
	])
		expect((await fetch(`${f.base}/reading/${path}`)).status).toBe(404);
	expect((await fetch(`${f.base}/unknown`)).status).toBe(404);
	expect((await fetch(`${f.base}/linked/`)).status).toBe(404);
});

test('only the view in ui/dist/ is served, never the ui/ source', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), {
		...readingApp,
		'ui/index.html': 'source',
	});
	expect((await fetch(`${f.base}/reading/`)).status).toBe(404);
	await mkdir(join(folder, 'ui', 'dist'), { recursive: true });
	await writeFile(join(folder, 'ui', 'dist', 'index.html'), 'built');
	expect(await (await fetch(`${f.base}/reading/`)).text()).toBe('built');
});

test('mismatched Origin is forbidden, and / refuses an event stream and other methods', async () => {
	const f = await setup();
	expect(
		(
			await fetch(`${f.base}/`, {
				headers: { accept: 'text/event-stream' },
			})
		).status,
	).toBe(405);
	expect((await fetch(`${f.base}/`, { method: 'DELETE' })).status).toBe(405);
	expect((await fetch(`${f.base}/mcp`)).status).toBe(404);
	expect((await mcp(f.base, 'tools/list', {})).status).toBe(200);
	expect(
		(
			await fetch(`${f.base}/`, {
				method: 'POST',
				headers: {
					origin: f.base,
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
			})
		).status,
	).toBe(200);
	expect(
		(
			await fetch(`${f.base}/`, {
				method: 'POST',
				headers: { origin: 'http://evil.example' },
			})
		).status,
	).toBe(403);
});
