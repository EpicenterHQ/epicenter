/**
 * HTTP serve acceptance tests.
 * Runs the real CLI against a temporary HOME and checks MCP calls, the
 * commits after them, the backup when serve stops, UI confinement, and
 * request origin handling. `http.test.ts` drives the backup clock's tick.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
	chmod,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@epicenter/app/client';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Action } from '@epicenter/app';
import {
	fixture,
	gitIn,
	gitignore,
	header,
	readingApp,
	startServe,
} from './runner.test-support.ts';

/** Talk's `say` as its app types it: takes words, yields each word, returns them joined. */
type TalkSay = Action<{ words: string }, Promise<string>, string>;

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

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Serve a new Epicenter once `prepare` has made and committed its apps. serve
 * backs up once when it starts, so a test makes its apps first, and nothing
 * is pending for that backup to take whenever it runs.
 */
async function setup<T = undefined>(
	prepare?: (f: Fixture) => Promise<T>,
	agents?: string,
) {
	const f = await fixture();
	if (agents !== undefined) await writeFile(join(f.home, 'AGENTS.md'), agents);
	const made = (await prepare?.(f)) as T;
	const served = await startServe(f);
	cleanups.push(async () => {
		await served.stop();
		await rm(f.root, { recursive: true, force: true });
	});
	return { ...f, made, ...served };
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

test('HTTP initialize sends the Epicenter AGENTS.md as it reads now', async () => {
	const f = await setup(undefined, 'Use these apps through their actions.\n');
	const initialize = async () => {
		const response = await mcp(f.base, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '1' },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { instructions?: string };
		};
		return body.result.instructions;
	};
	expect(await initialize()).toBe('Use these apps through their actions.\n');
	await writeFile(join(f.home, 'AGENTS.md'), 'Ask before deleting.\n');
	expect(await initialize()).toBe('Ask before deleting.\n');
});

test('HTTP tools/list offers app actions', async () => {
	const f = await setup((f) => f.folder(join(f.apps, 'reading'), readingApp));
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
	const f = await setup((f) =>
		f.app(
			'outside',
			`export default defineApp({ description: 'Outside', collections: {}, actions: { run: defineAction({ description: 'Run', input: {}, run: async () => { await folder.write('data/ran.txt', 'yes'); return true; } }) } });`,
			f.root,
		),
	);
	const outside = f.made;
	const response = await mcp(f.base, 'tools/call', {
		name: `${outside}_run`,
		arguments: {},
	});
	const body = (await response.json()) as { result: { isError?: boolean } };
	expect(body.result.isError).toBe(true);
	expect(await Bun.file(join(outside, 'data/ran.txt')).exists()).toBe(false);
});

test('the browser client calls a tool without initialize and a write makes one named commit', async () => {
	const f = await setup((f) => f.folder(join(f.apps, 'reading'), readingApp));
	const folder = f.made;
	const client = connect<Reading>({
		app: 'reading',
		url: `${f.base}/`,
	});
	expect(expectOk(await client.log({ minutes: 30 }))).toEqual({
		minutes: 30,
		book: null,
	});
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
	expect(await gitIn(join(folder, 'data'), 'rev-list', '--count', 'HEAD')).toBe(
		'2',
	);
	expect(await gitIn(join(folder, 'data'), 'log', '-1', '--format=%s')).toBe(
		'reading: log 30',
	);
	expect(
		await gitIn(join(folder, 'data'), 'log', '-1', '--format=%B'),
	).toContain(`Code-Commit: ${await gitIn(folder, 'rev-parse', 'HEAD')}`);
	expect(await readFile(join(folder, 'data/2026.csv'), 'utf8')).toBe(
		'minutes,book\n30,\n',
	);
});

test('a read-only action makes no commit, and one that throws after writing commits pending data as the call that threw', async () => {
	const f = await setup((f) => f.folder(join(f.apps, 'reading'), readingApp));
	const folder = f.made;
	const client = connect<Reading>({ app: 'reading', url: `${f.base}/` });
	// Nothing is pending, so serve's startup backup commits nothing whenever it runs.
	expect(expectOk(await client.week.show())).toBe(210);
	expect(expectOk(await client.week.show())).toBe(210);
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
	expect(expectErr(await client.explode())).toEqual({
		name: 'Threw',
		message: 'line 4 is not a number',
		thrown: undefined,
	});
	expect(await gitIn(join(folder, 'data'), 'log', '-1', '--format=%s')).toBe(
		'reading: explode (threw)',
	);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
});

test('a call whose snapshot fails still resolves, and the app says why', async () => {
	const f = await setup(async (f) => {
		const folder = await f.folder(join(f.apps, 'reading'), readingApp);
		await writeFile(
			join(folder, '.gitattributes'),
			'*.csv filter=lfs diff=lfs merge=lfs -text\n',
		);
		return folder;
	});
	const folder = f.made;
	const client = connect<Reading>({ app: 'reading', url: `${f.base}/` });
	expect(expectOk(await client.log({ minutes: 5 }))).toEqual({
		minutes: 5,
		book: null,
	});
	expect(await gitIn(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
	expect(
		JSON.parse((await f.run('reading', '--json')).stdout).status,
	).toMatchObject({
		code: { pending: 1, backup: 'none' },
		data: { pending: 1, backup: 'none' },
	});
});

test('concurrent writes through update both land, and both are in history', async () => {
	const f = await setup((f) => f.folder(join(f.apps, 'reading'), readingApp));
	const folder = f.made;
	const client = connect<Reading>({ app: 'reading', url: `${f.base}/` });
	for (const result of await Promise.all([
		client.log({ minutes: 10 }),
		client.log({ minutes: 20 }),
	]))
		expectOk(result);
	expect(await readFile(join(folder, 'data/2026.csv'), 'utf8')).toMatch(
		/^minutes,book\n(?:10,\n20,|20,\n10,)\n$/,
	);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
	const history = await gitIn(join(folder, 'data'), 'log', '--format=%s');
	expect(history).toMatch(/reading: log (10|20)/);
	expect(
		await gitIn(join(folder, 'data'), 'rev-list', '--count', 'HEAD'),
	).toMatch(/^[23]$/);
});

test('two calls at once on different files take turns and make separate data commits', async () => {
	const f = await setup((f) =>
		f.app(
			'notes',
			`export default defineApp({ description: 'Notes', collections: {}, actions: {
		write: defineAction({ description: 'Write a page', input: { page: field.text() }, positional: ['page'],
			run: async ({ page }) => { await folder.write('data/' + page + '.md', page); return page; } }),
	} });`,
		),
	);
	const folder = f.made;
	const client = connect<{
		actions: { write: (input: { page: string }) => string };
	}>({ app: 'notes', url: `${f.base}/` });
	// After a call, the backup serve started with has passed this app.
	expectOk(await client.write({ page: 'sunday' }));
	await writeFile(join(folder, 'data/by-hand.md'), 'by hand\n');
	for (const result of await Promise.all([
		client.write({ page: 'monday' }),
		client.write({ page: 'tuesday' }),
	]))
		expectOk(result);
	const commits = (
		await gitIn(join(folder, 'data'), 'log', '-2', '--format=%s')
	).split('\n');
	expect(commits.sort()).toEqual([
		'notes: write monday',
		'notes: write tuesday',
	]);
	for (const rev of ['HEAD', 'HEAD~1']) {
		const subject = await gitIn(
			join(folder, 'data'),
			'log',
			'-1',
			'--format=%s',
			rev,
		);
		expect(
			await gitIn(
				join(folder, 'data'),
				'show',
				'--name-only',
				'--format=',
				rev,
			),
		).toBe(`${subject.slice('notes: write '.length)}.md`);
	}
	expect(
		await gitIn(join(folder, 'data'), 'log', '-1', '--format=%s', 'HEAD~2'),
	).toBe('notes: changed outside epicenter');
	expect(
		await gitIn(
			join(folder, 'data'),
			'show',
			'--name-only',
			'--format=',
			'HEAD~2',
		),
	).toBe('by-hand.md');
	expect(await gitIn(join(folder, 'data'), 'status', '--porcelain')).toBe('');
});

test("a backup that runs during a call leaves the call's writes to the call's one commit", async () => {
	// The backup serve starts with commits an app that sorts first, slowly,
	// and reaches notes while the call to notes is between its two writes.
	const f = await setup(async (f) => {
		const slow = await f.app(
			'aaa',
			"export default defineApp({ description: 'Slow to commit', collections: {}, actions: {} });\n",
		);
		await mkdir(join(slow, 'data'));
		await writeFile(join(slow, 'data/pending.md'), 'pending\n');
		await writeFile(join(slow, 'pending-code.md'), 'pending\n');
		const hook = join(slow, '.git', 'hooks', 'pre-commit');
		await writeFile(hook, '#!/bin/sh\nsleep 2\n');
		await chmod(hook, 0o755);
		return f.app(
			'notes',
			`export default defineApp({ description: 'Notes', collections: {}, actions: {
		pair: defineAction({ description: 'Write two pages, apart', input: {},
			run: async () => { await folder.write('data/a.md', 'a'); await Bun.sleep(3000); await folder.write('data/b.md', 'b'); return true; } }),
	} });`,
		);
	});
	const folder = f.made;
	expectOk(
		await connect<{ actions: { pair: () => boolean } }>({
			app: 'notes',
			url: `${f.base}/`,
		}).pair(),
	);
	expect(await gitIn(join(folder, 'data'), 'log', '--format=%s')).toBe(
		'notes: pair\nnotes: start its data',
	);
	expect(
		await gitIn(
			join(folder, 'data'),
			'show',
			'--name-only',
			'--format=',
			'HEAD',
		),
	).toBe('a.md\nb.md');
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
	expect(
		await gitIn(join(f.apps, 'aaa', 'data'), 'log', '-1', '--format=%s'),
	).toBe('aaa: changed outside epicenter');
});

/** Reading, backed up to a bare `origin` it has pushed to. */
async function backedUpReading(f: Fixture) {
	const folder = await f.folder(join(f.apps, 'reading'), readingApp);
	await mkdir(join(folder, 'data'));
	await f.run('sync', 'reading');
	const remote = join(f.root, 'remote.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(join(folder, 'data'), 'remote', 'add', 'origin', remote);
	await gitIn(join(folder, 'data'), 'push', '-q', '-u', 'origin', 'HEAD');
	return { folder, remote };
}

test('serve reports a refused backup push and leaves both histories intact', async () => {
	const f = await setup(backedUpReading);
	const { folder, remote } = f.made;
	const peer = join(f.root, 'peer');
	await gitIn(f.root, 'clone', '-q', remote, peer);
	await writeFile(join(peer, 'peer.md'), 'from peer\n');
	await gitIn(peer, 'add', 'peer.md');
	await gitIn(peer, 'commit', '-q', '-m', 'peer');
	await gitIn(peer, 'push', '-q');
	expectOk(
		await connect<Reading>({ app: 'reading', url: `${f.base}/` }).log({
			minutes: 42,
		}),
	);
	expect(await f.stop()).toBe(0);
	expect(f.stderr()).toContain(
		'the backup at origin has changes this computer does not; nothing was overwritten',
	);
	const branch = await gitIn(
		join(folder, 'data'),
		'symbolic-ref',
		'--short',
		'HEAD',
	);
	expect(f.stderr()).toContain(
		`git -C ${folder}/data fetch origin && git -C ${folder}/data log HEAD..origin/${branch}`,
	);
	expect(await gitIn(remote, 'log', '-1', '--format=%s')).toBe('peer');
	expect(await gitIn(join(folder, 'data'), 'log', '-1', '--format=%s')).toBe(
		'reading: log 42',
	);
});

test('a write call is pushed by the backup clock, not by the call; serve backs up once more when it stops', async () => {
	const f = await setup(backedUpReading);
	const { folder, remote } = f.made;
	expectOk(
		await connect<Reading>({
			app: 'reading',
			url: `${f.base}/`,
		}).log({ minutes: 42 }),
	);
	expect(await gitIn(join(folder, 'data'), 'log', '-1', '--format=%s')).toBe(
		'reading: log 42',
	);
	expect(await gitIn(remote, 'log', '-1', '--format=%s')).toBe(
		'reading: start its data',
	);
	await writeFile(join(folder, 'data/notes.md'), 'by hand\n');
	expect(await f.stop()).toBe(0);
	expect(await gitIn(remote, 'log', '--format=%s')).toBe(
		'reading: changed outside epicenter\nreading: log 42\nreading: start its data',
	);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
});

test('commit subjects use the first positional value on one line, capped at 60 characters', async () => {
	const f = await setup((f) =>
		f.app(
			'notes',
			`export default defineApp({ description: 'The notes app', collections: {}, actions: {
		add: defineAction({ description: 'Add a note', input: { text: field.text() }, positional: ['text'],
			run: async ({ text }) => { await folder.write('data/note.txt', text); return text; } }),
	} });`,
		),
	);
	const folder = f.made;
	const text = `Fear is the mind-killer ${'x'.repeat(80)}\nsecond line`;
	expectOk(
		await connect<{ actions: { add: (input: { text: string }) => string } }>({
			app: 'notes',
			url: `${f.base}/`,
		}).add({ text }),
	);
	expect(await gitIn(join(folder, 'data'), 'log', '-1', '--format=%s')).toBe(
		`notes: add ${text.replace(/\s+/g, ' ').slice(0, 60)}`,
	);
});

test('a built UI serves files and refuses traversal and symlinks outside it', async () => {
	const f = await setup(async (f) => ({
		folder: await f.folder(join(f.apps, 'reading'), readingApp),
		linked: await f.app(
			'linked',
			`export default defineApp({ description: 'Linked UI', collections: {}, actions: {} });\n`,
		),
	}));
	const { folder, linked } = f.made;
	await mkdir(join(folder, 'ui', 'dist', '_app', 'immutable'), {
		recursive: true,
	});
	await writeFile(join(folder, 'ui', 'dist', 'index.html'), '<h1>Reading</h1>');
	await writeFile(
		join(folder, 'ui', 'dist', '_app', 'immutable', 'asset.js'),
		'export {};',
	);
	await symlink(
		join(folder, 'epicenter.ts'),
		join(folder, 'ui', 'dist', 'outside.ts'),
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

test('serve builds the UI as it sits on disk when a page opens, waits only for the first build, and keeps the last good build through a failure', async () => {
	const f = await setup((f) =>
		f.folder(join(f.apps, 'reading'), {
			...readingApp,
			'.gitignore': `${readingApp['.gitignore']}ui/dist/\n`,
			'package.json': `${JSON.stringify({ scripts: { build: 'mkdir -p "$EPICENTER_OUT" && cp ui/page.txt "$EPICENTER_OUT/index.html" && grep -qv broken ui/page.txt' } })}\n`,
			'ui/page.txt': 'one\n',
		}),
	);
	const folder = f.made;
	/** The UI's page once it reads `text`, opening it until it does. */
	const opened = async (text: string) => {
		for (let tries = 0; tries < 100; tries++) {
			const response = await fetch(`${f.base}/reading/`);
			if (response.ok && (await response.text()) === text) return true;
			await Bun.sleep(100);
		}
		return false;
	};
	// The first page load waits for the UI's first build rather than answering 404.
	const first = await fetch(`${f.base}/reading/`);
	expect([first.status, await first.text()]).toEqual([200, 'one\n']);
	// Uncommitted: the UI runs as it sits on disk.
	await writeFile(join(folder, 'ui', 'page.txt'), 'two\n');
	expect(await opened('two\n')).toBe(true);
	await writeFile(join(folder, 'ui', 'page.txt'), 'broken\n');
	await fetch(`${f.base}/reading/`);
	for (
		let tries = 0;
		tries < 100 && !f.stderr().includes('did not build');
		tries++
	)
		await Bun.sleep(100);
	expect(f.stderr()).toContain('reading: the UI did not build');
	expect(await (await fetch(`${f.base}/reading/`)).text()).toBe('two\n');
	await writeFile(join(folder, 'ui', 'page.txt'), 'three\n');
	expect(await opened('three\n')).toBe(true);
	expect((await fetch(`${f.base}/reading/.epicenter-build`)).status).toBe(404);
});

/** Talk: `say` yields each word and returns them joined; `drip` writes, then yields until its caller stops listening. */
const talk = `export default defineApp({ description: 'Talk', collections: {}, actions: {
	say: defineAction({
		description: 'Say words one at a time',
		input: { words: field.text() },
		positional: ['words'],
		async *run({ words }) {
			for (const word of words.split(' ')) yield word;
			return words;
		},
	}),
	drip: defineAction({
		description: 'Write, then yield until stopped',
		input: {},
		async *run() {
			await folder.write('data/started.md', 'started');
			try {
				for (let i = 0; i < 600; i++) {
					yield i;
					await Bun.sleep(50);
				}
			} finally {
				await folder.write('data/stopped.md', 'stopped');
			}
			return 'never stopped';
		},
	}),
} });
`;

test("a UI's call gets each value the action yields, in order, then its answer; MCP gets only the answer", async () => {
	const f = await setup((f) => f.app('talk', talk));
	const heard: unknown[] = [];
	const client = connect<{ actions: { say: TalkSay } }>({
		app: 'talk',
		url: `${f.base}/`,
	});
	const said = await client.say(
		{ words: 'one two three' },
		{ onYield: (word) => heard.push(word) },
	);
	expect(expectOk(said)).toBe('one two three');
	expect(heard).toEqual(['one', 'two', 'three']);

	const raw = await fetch(`${f.base}/talk/say`, {
		method: 'POST',
		body: JSON.stringify({ words: 'a b' }),
	});
	expect(raw.headers.get('content-type')).toBe('application/x-ndjson');
	expect(await raw.text()).toBe(
		'{"yielded":"a"}\n{"yielded":"b"}\n{"answer":{"returned":"a b"}}\n',
	);
	const refused = await fetch(`${f.base}/talk/say`, {
		method: 'POST',
		body: JSON.stringify({}),
	});
	expect(JSON.parse(await refused.text())).toEqual({
		answer: {
			error: {
				name: 'Usage',
				message: 'words is needed',
				next: 'epicenter talk say --help',
			},
		},
	});
	expect(
		(
			await fetch(`${f.base}/talk/say`, {
				method: 'POST',
				headers: { origin: 'http://evil.example' },
				body: JSON.stringify({ words: 'no' }),
			})
		).status,
	).toBe(403);

	const answered = await mcp(f.base, 'tools/call', {
		name: 'talk_say',
		arguments: { words: 'x y' },
	});
	const body = (await answered.json()) as {
		result: { structuredContent: unknown };
	};
	expect(body.result.structuredContent).toEqual({ returned: 'x y' });
});

test('a caller that stops reading stops the action at its next yield; its finally runs and what it wrote is committed', async () => {
	const f = await setup((f) => f.app('talk', talk));
	const stop = new AbortController();
	const response = await fetch(`${f.base}/talk/drip`, {
		method: 'POST',
		body: '{}',
		signal: stop.signal,
	});
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	expect(first).toStartWith('{"yielded":0}\n');
	stop.abort();
	const data = join(f.apps, 'talk', 'data');
	const latest = () => gitIn(data, 'log', '-1', '--format=%s');
	const deadline = Date.now() + 10_000;
	while (!(await latest()).startsWith('talk: drip') && Date.now() < deadline)
		await Bun.sleep(50);
	expect(await latest()).toBe('talk: drip (threw)');
	expect(
		(await gitIn(data, 'show', '--name-only', '--format=', 'HEAD')).split('\n'),
	).toEqual(['started.md', 'stopped.md']);
});

test('an edit to epicenter.ts, or to a file it imports, reaches the next call without restarting serve', async () => {
	const f = await setup((f) =>
		f.folder(join(f.apps, 'echo'), {
			'.gitignore': gitignore,
			'word.ts': "export const word = 'one';\n",
			'epicenter.ts': `${header}import { word } from './word.ts';
export default defineApp({ description: 'Echo', collections: {}, actions: {
	hello: defineAction({ description: 'Say the word', input: {}, run: () => word }),
} });
`,
		}),
	);
	const client = connect<{ actions: { hello: () => string } }>({
		app: 'echo',
		url: `${f.base}/`,
	});
	expect(expectOk(await client.hello())).toBe('one');
	await writeFile(join(f.made, 'word.ts'), "export const word = 'two';\n");
	expect(expectOk(await client.hello())).toBe('two');
	await writeFile(
		join(f.made, 'epicenter.ts'),
		`${header}export default defineApp({ description: 'Echo', collections: {}, actions: {
	hello: defineAction({ description: 'Say the word', input: {}, run: () => 'three' }),
} });
`,
	);
	expect(expectOk(await client.hello())).toBe('three');
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
