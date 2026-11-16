/**
 * HTTP serve acceptance tests.
 * Runs the real CLI against a temporary HOME and checks MCP calls, the
 * returned answers, concurrent writes, UI confinement, and
 * request origin handling. `http.test.ts` drives the backup clock's tick.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Action } from '@epicenter/app';
import { connect, runs } from '@epicenter/app/client';
import type { Ok, Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { hold } from './lock.ts';
import {
	fixture,
	gitignore,
	header,
	readingApp,
	startServe,
} from './runner.test-support.ts';

/** Talk's `say` as its app types it: takes words, yields each word, returns them joined. */
type TalkSay = Action<{ words: string }, Promise<Ok<string>>, string>;

/** Reading's actions as its UI calls them, for `connect`. */
type Reading = {
	actions: {
		log: (input: { minutes: number; book?: string }) => Ok<{
			minutes: number;
			book: string | null;
		}>;
		week: { show: () => Ok<number> };
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
 * Serve a temporary Epicenter after preparing its apps.
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
			`export default defineApp({ description: 'Outside', collections: {}, actions: { run: defineAction({ description: 'Run', input: {}, run: async () => { await folder.write('data/ran.txt', 'yes'); return Ok(true); } }) } });`,
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

test('the browser client calls a tool without initialize and writes its record', async () => {
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

	expect(await readFile(join(folder, 'data/2026.csv'), 'utf8')).toBe(
		'minutes,book\n30,\n',
	);
});

test('read-only calls return and a write followed by a throw preserves its error', async () => {
	const f = await setup((f) => f.folder(join(f.apps, 'reading'), readingApp));
	const client = connect<Reading>({ app: 'reading', url: `${f.base}/` });
	// Read-only calls and throwing calls preserve their return/error contracts.
	expect(expectOk(await client.week.show())).toBe(210);
	expect(expectOk(await client.week.show())).toBe(210);

	expect(expectErr(await client.explode())).toEqual({
		namespace: 'epicenter/action-error',
		name: 'Threw',
		message: 'line 4 is not a number',
		thrown: undefined,
	});
});

test('concurrent updates to one record both land', async () => {
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
});

test('two calls at once on different files preserve both records', async () => {
	const f = await setup((f) =>
		f.app(
			'notes',
			`export default defineApp({ description: 'Notes', collections: {}, actions: {
		write: defineAction({ description: 'Write a page', input: { page: field.text() },
			run: async ({ page }) => { await folder.write('data/' + page + '.md', page); return Ok(page); } }),
	} });`,
		),
	);
	const folder = f.made;
	const client = connect<{
		actions: { write: (input: { page: string }) => Ok<string> };
	}>({ app: 'notes', url: `${f.base}/` });
	// Changes beside concurrent calls survive their writes.
	expectOk(await client.write({ page: 'sunday' }));
	await writeFile(join(folder, 'data/by-hand.md'), 'by hand\n');
	for (const result of await Promise.all([
		client.write({ page: 'monday' }),
		client.write({ page: 'tuesday' }),
	]))
		expectOk(result);
	expect(await readFile(join(folder, 'data/monday.md'), 'utf8')).toBe('monday');
	expect(await readFile(join(folder, 'data/tuesday.md'), 'utf8')).toBe(
		'tuesday',
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
	await mkdir(join(folder, 'code', 'ui', 'dist', '_app', 'immutable'), {
		recursive: true,
	});
	await writeFile(
		join(folder, 'code', 'ui', 'dist', 'index.html'),
		'<h1>Reading</h1>',
	);
	await writeFile(
		join(folder, 'code', 'ui', 'dist', '_app', 'immutable', 'asset.js'),
		'export {};',
	);
	await symlink(
		join(folder, 'code/epicenter.ts'),
		join(folder, 'code', 'ui', 'dist', 'outside.ts'),
	);
	const outsideUi = join(f.root, 'outside-ui');
	await mkdir(outsideUi);
	await writeFile(join(outsideUi, 'index.html'), 'outside');
	await mkdir(join(linked, 'code', 'ui'));
	await symlink(outsideUi, join(linked, 'code', 'ui', 'dist'));
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
			'code/.gitignore': `${readingApp['code/.gitignore']}ui/dist/\n`,
			'code/package.json': `${JSON.stringify({ scripts: { build: 'mkdir -p "$EPICENTER_OUT" && cp ui/page.txt "$EPICENTER_OUT/index.html" && grep -qv broken ui/page.txt' } })}\n`,
			'code/ui/page.txt': 'one\n',
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
	await writeFile(join(folder, 'code', 'ui', 'page.txt'), 'two\n');
	expect(await opened('two\n')).toBe(true);
	await writeFile(join(folder, 'code', 'ui', 'page.txt'), 'broken\n');
	await fetch(`${f.base}/reading/`);
	for (
		let tries = 0;
		tries < 100 && !f.stderr().includes('did not build');
		tries++
	)
		await Bun.sleep(100);
	expect(f.stderr()).toContain('reading: the UI did not build');
	expect(await (await fetch(`${f.base}/reading/`)).text()).toBe('two\n');
	await writeFile(join(folder, 'code', 'ui', 'page.txt'), 'three\n');
	expect(await opened('three\n')).toBe(true);
	expect((await fetch(`${f.base}/reading/.epicenter-build`)).status).toBe(404);
});

/**
 * Talk: `say` yields each word and returns them joined; `drip` writes, then
 * yields until its caller stops listening; `wait` yields once, then waits a
 * minute unless its call's signal ends the wait.
 */
const talk = `import { callSignal } from '@epicenter/app';
export default defineApp({ description: 'Talk', collections: {}, actions: {
	wait: defineAction({
		description: 'Yield, then wait for a stop',
		input: {},
		async *run() {
			yield 'waiting';
			try {
				await new Promise((resolve) => {
					const timer = setTimeout(resolve, 60_000);
					callSignal().addEventListener('abort', () => {
						clearTimeout(timer);
						resolve(undefined);
					});
				});
			} finally {
				await folder.write('data/waited.md', 'waited');
			}
			return Ok('waited');
		},
	}),
 refuse: defineAction({description:'Refuse after checking',input:{},async *run(){yield 'checked';return Err({name:'NoRoute',message:'No route from LAX',airport:'LAX'});}}),
	say: defineAction({
		description: 'Say words one at a time',
		input: { words: field.text() },
		async *run({ words }) {
			for (const word of words.split(' ')) yield word;
			return Ok(words);
		},
	}),
	drip: defineAction({
		description: 'Write, then yield until stopped',
		input: {},
		async *run() {
			await folder.write('data/started.md', 'started');
			try {
				for (let i = 0; i < 5; i++) {
					yield i;
					await Bun.sleep(50);
				}
			} finally {
				await folder.write('data/stopped.md', 'stopped');
			}
			return Ok('never stopped');
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
	expect(JSON.parse(await raw.text()).answer.error.message).toBe(
		'This page is out of date. Reload it to keep using talk.',
	);
	expect(
		(
			await fetch(`${f.base}/.runs/talk/say/${crypto.randomUUID()}`, {
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
	expect(body.result.structuredContent).toEqual({
		result: { data: 'x y', error: null },
	});
});

test('an aborted observer leaves the action running to its finally', async () => {
	const f = await setup((f) => f.app('talk', talk));
	const client = connect<{
		actions: {
			drip: Action<Record<string, never>, Promise<Ok<string>>, number>;
		};
	}>({ app: 'talk', url: `${f.base}/` });
	const run = runs.start(client.drip, {});
	const stop = new AbortController();
	for await (const event of run.events({ signal: stop.signal }))
		if (event.type === 'yielded') stop.abort();
	const path = join(f.apps, 'talk', 'data', 'stopped.md');
	const deadline = Date.now() + 10_000;
	while (!(await Bun.file(path).exists()) && Date.now() < deadline)
		await Bun.sleep(50);
	expect(await Bun.file(path).exists()).toBe(true);
	expectOk(await run.result());
});

test('a callback failure leaves the action running to finally and releases the lock', async () => {
	const f = await setup((f) => f.app('talk', talk));
	const client = connect<{
		actions: {
			drip: Action<Record<string, never>, Promise<Ok<string>>, number>;
		};
	}>({
		app: 'talk',
		url: `${f.base}/`,
	});
	const bug = new Error('UI callback failed');
	await expect(
		client.drip(
			{},
			{
				onYield: async () => {
					throw bug;
				},
			},
		),
	).rejects.toBe(bug);
	const data = join(f.apps, 'talk', 'data');
	const latest = () => Bun.file(join(data, 'stopped.md')).exists();
	const deadline = Date.now() + 10_000;
	while (!(await latest()) && Date.now() < deadline) await Bun.sleep(50);
	expect(await latest()).toBe(true);

	// The finally write can become visible just before the run releases its lock.
	const held = await hold(join(f.apps, 'talk'), 1000);
	try {
		expect(held).toBeDefined();
	} finally {
		held?.release();
	}
});

test('unserializable action throws still answer Threw, preserve writes, and release the app lock', async () => {
	const f = await setup((f) =>
		f.app(
			'failure',
			`
export default defineApp({ description: 'Failure', collections: {}, actions: {
	fail: defineAction({ description: 'Write then throw', input: { kind: field.text() },
		run: async ({ kind }) => {
			await folder.write('data/' + kind + '.md', kind);
			if (kind === 'returned') return Err({name:'Problem',message:'action failed',details:1n});
			if (kind === 'array') throw [1n];
			const thrown = { name: 'Problem', message: 'action failed', details: 1n };
			if (kind === 'cycle') thrown.details = thrown;
			if (kind === 'replacement') thrown.toJSON = () => 42;
			if (kind === 'json') thrown.details = 'kept';
			throw thrown;
		},
	}),
} });`,
		),
	);
	const client = connect<{
		actions: { fail: (input: { kind: string }) => never };
	}>({
		app: 'failure',
		url: `${f.base}/`,
	});
	for (const kind of [
		'bigint',
		'cycle',
		'replacement',
		'array',
		'json',
		'returned',
	]) {
		const error = expectErr(await client.fail({ kind }));
		expect(error.name).toBe('Threw');
		if (kind !== 'returned')
			expect(error).toMatchObject({
				name: 'Threw',
				message:
					kind === 'array'
						? 'The action threw a value that could not be read'
						: 'action failed',
			});
		if (error.name === 'Threw')
			expect(error.thrown).toEqual(
				kind === 'json'
					? { name: 'Problem', message: 'action failed', details: 'kept' }
					: undefined,
			);

		expect(
			await readFile(join(f.apps, 'failure', 'data', `${kind}.md`), 'utf8'),
		).toBe(kind);
		const held = await hold(join(f.apps, 'failure'), 0);
		try {
			expect(held).toBeDefined();
		} finally {
			held?.release();
		}
	}
});

test('shared errors cross a real call after writes without claiming rollback or changing custom error depth', async () => {
	const f = await setup((f) =>
		f.app(
			'failures',
			`
import { ActionError } from '@epicenter/app';
export default defineApp({ description: 'Shared failures', collections: {}, actions: {
	fail: defineAction({ description: 'Write then fail', input: { kind: field.text(), how: field.text() },
		run: async ({ kind, how }) => {
			await folder.write('data/' + how + '-' + kind + '.md', kind);
			const custom = { name: 'ProposalChanged', message: 'Review again', proposal: 'p' };
			const cases = {
				Changed: ActionError.Changed({ path: 'data/a.md', why: 'quote' }).error,
				Missing: ActionError.Missing({ path: 'data/a.md' }).error,
				Threw: ActionError.Threw({ message: custom.message, thrown: custom }).error,
				Refused: ActionError.Refused({ message: 'Dependency declined', next: 'Inspect dependency' }).error,
				Unreachable: ActionError.Unreachable({ message: 'The model did not answer' }).error,
				Stopped: ActionError.Stopped({ message: 'The dependency stopped' }).error,
				Custom: custom,
			};
			if(how==='return') return Err(cases[kind]);
			throw cases[kind];
		},
	}),
} });`,
		),
	);
	const client = connect<{
		actions: {
			fail: (input: {
				kind: string;
				how: string;
			}) => Result<
				never,
				{ name: string; message: string; namespace?: string; proposal?: string }
			>;
		};
	}>({ app: 'failures', url: `${f.base}/` });
	for (const how of ['return', 'throw']) {
		for (const kind of [
			'Changed',
			'Missing',
			'Threw',
			'Refused',
			'Unreachable',
			'Stopped',
			'Custom',
		]) {
			const error = expectErr(await client.fail({ kind, how }));
			if (how === 'throw') {
				expect(error).toMatchObject({
					name: 'Threw',
					namespace: 'epicenter/action-error',
					thrown: { name: kind === 'Custom' ? 'ProposalChanged' : kind },
				});
			} else {
				expect(error?.name).toBe(kind === 'Custom' ? 'ProposalChanged' : kind);
				if (kind === 'Custom') {
					expect(error).toHaveProperty('proposal', 'p');
					expect(error).not.toHaveProperty('namespace');
				} else
					expect(error).toHaveProperty('namespace', 'epicenter/action-error');
			}
			expect(
				await readFile(
					join(f.apps, 'failures', 'data', `${how}-${kind}.md`),
					'utf8',
				),
			).toBe(kind);
		}
		const raw = await fetch(
			`${f.base}/.runs/failures/fail/${crypto.randomUUID()}`,
			{ method: 'POST', body: JSON.stringify({ kind: 'Missing', how }) },
		);
		const frames = (await raw.text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(frames.at(-1)).toMatchObject({
			type: 'finished',
			answer:
				how === 'return'
					? {
							result: {
								data: null,
								error: {
									namespace: 'epicenter/action-error',
									name: 'Missing',
									message: 'There is no data/a.md',
									path: 'data/a.md',
								},
							},
						}
					: {
							fault: {
								message: 'There is no data/a.md',
								thrown: {
									namespace: 'epicenter/action-error',
									name: 'Missing',
									path: 'data/a.md',
								},
							},
						},
		});
	}
});

test('run.cancel reaches callSignal and runs finally', async () => {
	const f = await setup((f) => f.app('talk', talk));
	const client = connect<{
		actions: {
			wait: Action<Record<string, never>, Promise<Ok<string>>, string>;
		};
	}>({ app: 'talk', url: `${f.base}/` });
	const run = runs.start(client.wait, {});
	for await (const event of run.events()) {
		if (event.type === 'yielded') {
			expectOk(await run.cancel());
			break;
		}
	}
	const path = join(f.apps, 'talk', 'data', 'waited.md');
	const deadline = Date.now() + 10_000;
	while (!(await Bun.file(path).exists()) && Date.now() < deadline)
		await Bun.sleep(50);
	expect(await Bun.file(path).exists()).toBe(true);
	await run.result();
});

test('a killed host interrupts an accepted run and never executes it again', async () => {
	const f = await fixture();
	f.env.EPICENTER_RUNTIME_DIR = join(f.root, 'runtime');
	await f.app(
		'restart',
		`import { callSignal } from '@epicenter/app';
export default defineApp({ description: 'Restart', collections: {}, actions: {
 slow: defineAction({ description: 'Wait', input: {}, async *run() {
  await folder.update('data/count.local', (value = '0') => String(Number(value) + 1));
  yield 'started';
  await new Promise((resolve) => { const timer = setTimeout(resolve, 60000); callSignal().addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }); });
  return Ok(null);
 } }),
} });`,
	);
	let server: Awaited<ReturnType<typeof startServe>> | undefined;
	try {
		server = await startServe(f);
		const client = connect<{
			actions: {
				slow: Action<Record<string, never>, Promise<Ok<null>>, string>;
			};
		}>({ app: 'restart', url: `${server.base}/` });
		const run = runs.start(client.slow, {});
		for await (const event of run.events()) if (event.type === 'yielded') break;
		await server.kill();
		server = await startServe(f);
		const restored = connect<{
			actions: {
				slow: Action<Record<string, never>, Promise<Ok<null>>, string>;
			};
		}>({ app: 'restart', url: `${server.base}/` });
		const frames = [];
		for await (const event of runs.attach(restored.slow, run.id).events())
			frames.push(event);
		expect(frames.at(-1)?.type).toBe('interrupted');
		const joined = await fetch(`${server.base}/.runs/restart/slow/${run.id}`, {
			method: 'POST',
			body: '{}',
		});
		expect(joined.status).toBe(200);
		await joined.text();
		expect(
			await readFile(join(f.apps, 'restart', 'data', 'count.local'), 'utf8'),
		).toBe('1');
	} finally {
		if (server) await server.stop();
		await rm(f.root, { recursive: true, force: true });
	}
}, 20_000);

test('an edit to epicenter.ts, or to a file it imports, reaches the next call without restarting serve', async () => {
	const f = await setup((f) =>
		f.folder(join(f.apps, 'echo'), {
			'code/.gitignore': gitignore,
			'code/word.ts': "export const word = 'one';\n",
			'code/epicenter.ts': `${header}import { word } from './word.ts';
export default defineApp({ description: 'Echo', collections: {}, actions: {
	hello: defineAction({ description: 'Say the word', input: {}, run: () => Ok(word) }),
} });
`,
		}),
	);
	const client = connect<{ actions: { hello: () => Ok<string> } }>({
		app: 'echo',
		url: `${f.base}/`,
	});
	expect(expectOk(await client.hello())).toBe('one');
	await writeFile(join(f.made, 'code/word.ts'), "export const word = 'two';\n");
	expect(expectOk(await client.hello())).toBe('two');
	await writeFile(
		join(f.made, 'code/epicenter.ts'),
		`${header}export default defineApp({ description: 'Echo', collections: {}, actions: {
	hello: defineAction({ description: 'Say the word', input: {}, run: () => Ok('three') }),
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

test('cross-origin requests to run routes are refused before admission', async () => {
	const f = await setup();
	const response = await fetch(
		`${f.base}/.runs/reading/log/unknown-run-identifier`,
		{
			method: 'POST',
			headers: {
				origin: 'https://another.example',
				'content-type': 'application/json',
			},
			body: '{}',
		},
	);
	expect(response.status).toBe(403);
});

test('a yielded check precedes a returned app refusal for UI and raw HTTP callers', async () => {
	const f = await setup((f) => f.app('talk', talk));
	const client = connect<{
		actions: {
			refuse: Action<
				Record<string, never>,
				Promise<
					Result<never, { name: 'NoRoute'; message: string; airport: string }>
				>,
				string
			>;
		};
	}>({ app: 'talk', url: `${f.base}/` });
	const heard: string[] = [];
	expect(
		expectErr(
			await client.refuse(
				{},
				{
					onYield: (word) => {
						heard.push(word);
					},
				},
			),
		),
	).toEqual({ name: 'NoRoute', message: 'No route from LAX', airport: 'LAX' });
	expect(heard).toEqual(['checked']);
	const raw = await fetch(
		`${f.base}/.runs/talk/refuse/${crypto.randomUUID()}`,
		{ method: 'POST', body: '{}' },
	);
	expect(raw.status).toBe(200);
	const frames = (await raw.text())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	expect(frames.at(-1)).toMatchObject({
		type: 'finished',
		answer: {
			result: { data: null, error: { name: 'NoRoute', airport: 'LAX' } },
		},
	});
});
