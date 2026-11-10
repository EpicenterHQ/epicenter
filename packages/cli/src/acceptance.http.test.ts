/**
 * HTTP serve acceptance tests.
 * Runs the real CLI against a temporary HOME and checks MCP calls, Git commits,
 * UI confinement, and request origin handling.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@epicenter/app/client';
import { fixture, gitIn, readingApp } from './runner.test-support.ts';

setDefaultTimeout(30_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
	const f = await fixture();
	const child = Bun.spawn([process.execPath, f.bin, 'serve', '--port', '0'], {
		cwd: f.root,
		env: f.env,
		stdout: 'ignore',
		stderr: 'pipe',
	});
	const ready = Promise.withResolvers<string>();
	void (async () => {
		let output = '';
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
	return { ...f, base };
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

test('HTTP tools/list offers app actions', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), readingApp);
	const response = await mcp(f.base, 'tools/list');
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		result: { tools: { name: string }[] };
	};
	expect(body.result.tools.map((tool) => tool.name)).toEqual([
		'reading_list',
		'reading_get',
		'reading_set',
		'reading_delete',
		'reading_log',
		'reading_between',
		'reading_week_show',
		'reading_explode',
	]);
});

test('a crafted tool name cannot run an app outside the home', async () => {
	const f = await setup();
	const outside = await f.folder(join(f.root, 'outside'), {
		'epicenter.json': JSON.stringify({ description: 'Outside' }),
		'epicenter.ts': `import { defineApp } from '@epicenter/app';
export default defineApp({}, { actions: { run: { description: 'Run', input: {}, run: async (_, { folder }) => { await folder.write('ran.txt', 'yes'); return true; } } } });`,
	});
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
	const client = connect('reading', { url: `${f.base}/` });
	expect(
		await client.call<{ minutes: number; book: null }>('log', { minutes: 30 }),
	).toEqual({ minutes: 30, book: null });
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('2');
	expect(await gitIn(folder, 'log', '-1', '--format=%s')).toBe(
		'reading: log 30',
	);
	expect(await readFile(join(folder, '2026.csv'), 'utf8')).toBe(
		'minutes,book\n30,\n',
	);
});

test('read-only and thrown actions make no commit', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const client = connect('reading', { url: `${f.base}/` });
	expect(await client.call<number>('week show')).toBe(210);
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
	await expect(client.call('explode')).rejects.toThrow(
		'line 4 is not a number',
	);
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
});

test('concurrent writes run one at a time and make one commit each', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const client = connect('reading', { url: `${f.base}/` });
	await Promise.all([
		client.call('log', { minutes: 10 }),
		client.call('log', { minutes: 20 }),
	]);
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('3');
	expect(
		(await gitIn(folder, 'log', '-2', '--format=%s')).split('\n').sort(),
	).toEqual(['reading: log 10', 'reading: log 20']);
	expect(await readFile(join(folder, '2026.csv'), 'utf8')).toMatch(
		/^minutes,book\n(?:10,\n20,|20,\n10,)\n$/,
	);
});

test('a successful write pushes to an upstream in the background', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const remote = join(f.root, 'remote.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(folder, 'remote', 'add', 'origin', remote);
	await gitIn(folder, 'push', '-q', '-u', 'origin', 'HEAD');
	await connect('reading', { url: `${f.base}/` }).call('log', {
		minutes: 42,
	});
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
		`export default defineApp(declaration, { actions: {
		add: { description: 'Add a note', input: { text: field.text() }, positional: ['text'],
			run: async ({ text }, { folder }) => { await folder.write('note.txt', text); return text; } },
	} });`,
	);
	const text = `Fear is the mind-killer ${'x'.repeat(80)}\nsecond line`;
	await connect('notes', { url: `${f.base}/` }).call('add', { text });
	expect(await gitIn(folder, 'log', '-1', '--format=%B')).toBe(
		`notes: add ${text.replace(/\s+/g, ' ').slice(0, 60)}`,
	);
});

test('a built UI serves files and refuses traversal and symlinks outside it', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	await mkdir(join(folder, '.cache', 'ui', '_app', 'immutable'), {
		recursive: true,
	});
	await writeFile(
		join(folder, '.cache', 'ui', 'index.html'),
		'<h1>Reading</h1>',
	);
	await writeFile(
		join(folder, '.cache', 'ui', '_app', 'immutable', 'asset.js'),
		'export {};',
	);
	await symlink(
		join(folder, 'epicenter.json'),
		join(folder, '.cache', 'ui', 'outside.json'),
	);
	const linked = await f.folder(join(f.home, 'linked'), {
		'epicenter.json': JSON.stringify({ description: 'Linked UI' }),
	});
	const outsideUi = join(f.root, 'outside-ui');
	await mkdir(outsideUi);
	await writeFile(join(outsideUi, 'index.html'), 'outside');
	await mkdir(join(linked, '.cache'));
	await symlink(outsideUi, join(linked, '.cache', 'ui'));
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
		'../epicenter.json',
		'%2e%2e/epicenter.json',
		'%2e%2e%2fepicenter.json',
		'outside.json',
	])
		expect((await fetch(`${f.base}/reading/${path}`)).status).toBe(404);
	expect((await fetch(`${f.base}/unknown`)).status).toBe(404);
	expect((await fetch(`${f.base}/linked/`)).status).toBe(404);
});

test('only the built UI in .cache/ui/ is served, never the ui/ source', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), {
		...readingApp,
		'ui/index.html': 'source',
	});
	expect((await fetch(`${f.base}/reading/`)).status).toBe(404);
	await mkdir(join(folder, '.cache', 'ui'), { recursive: true });
	await writeFile(join(folder, '.cache', 'ui', 'index.html'), 'built');
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
