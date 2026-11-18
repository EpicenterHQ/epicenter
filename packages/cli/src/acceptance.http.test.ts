/**
 * HTTP serve acceptance tests.
 * Runs the real CLI against a temporary HOME and checks MCP calls, the
 * returned answers, concurrent writes, UI confinement, and
 * request origin handling. `http.test.ts` covers serve's routine clock.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Action } from '@epicenter/app';
import { connect } from '@epicenter/app/client';
import type { Ok, Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	fixture,
	gitignore,
	header,
	readingApp,
	startServe,
} from './runner.test-support.ts';

/** Talk's `say` as its app types it: takes words, sends each word as an update, returns them joined. */
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
		'reading_books_create',
		'reading_books_patch',
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
			`export default defineApp({ description: 'Outside', actions: { run: defineAction({ description: 'Run', input: {}, run: async () => { await folder.write('data/ran.txt', 'yes'); return Ok(true); } }) } });`,
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
			`export default defineApp({ description: 'Notes', actions: {
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
			`export default defineApp({ description: 'Linked UI', actions: {} });\n`,
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

test('serve serves ui/dist/ as the build left it and never builds; an unbuilt UI is not found', async () => {
	const f = await setup((f) =>
		f.folder(join(f.apps, 'reading'), {
			...readingApp,
			'code/.gitignore': `${readingApp['code/.gitignore']}ui/dist/\n`,
			'code/package.json': `${JSON.stringify({ scripts: { build: 'touch built-by-serve' } })}\n`,
			'code/ui/page.txt': 'one\n',
		}),
	);
	const code = join(f.made, 'code');
	expect((await fetch(`${f.base}/reading/`)).status).toBe(404);
	expect((await fetch(`${f.base}/reading/main.js`)).status).toBe(404);
	await mkdir(join(code, 'ui', 'dist'), { recursive: true });
	await writeFile(join(code, 'ui', 'dist', 'index.html'), 'one\n');
	expect(await (await fetch(`${f.base}/reading/`)).text()).toBe('one\n');
	// An edit to ui/dist/ is what the next page load gets; ui/ itself is never read.
	await writeFile(join(code, 'ui', 'dist', 'index.html'), 'two\n');
	await writeFile(join(code, 'ui', 'page.txt'), 'three\n');
	expect(await (await fetch(`${f.base}/reading/`)).text()).toBe('two\n');
	expect(existsSync(join(code, 'built-by-serve'))).toBe(false);
});

/**
 * Talk: `say` sends each word as an update and returns them joined; `drip`
 * writes, sends five updates slowly, and writes again in its `finally`.
 */
const talk = `export default defineApp({ description: 'Talk', actions: {
 refuse: defineAction({description:'Refuse after checking',input:{},async run(_input, update){update('checked');return Err({name:'NoRoute',message:'No route from LAX',airport:'LAX'});}}),
	say: defineAction({
		description: 'Say words one at a time',
		input: { words: field.text() },
		async run({ words }, update) {
			for (const word of words.split(' ')) update(word);
			return Ok(words);
		},
	}),
	drip: defineAction({
		description: 'Write, then send updates slowly',
		input: {},
		async run(_input, update) {
			await folder.write('data/started.md', 'started');
			try {
				for (let i = 0; i < 5; i++) {
					update(i);
					await Bun.sleep(50);
				}
			} finally {
				await folder.write('data/stopped.md', 'stopped');
			}
			return Ok('dripped');
		},
	}),
	tangle: defineAction({
		description: 'Send an update that is not JSON between two that are',
		input: {},
		async run(_input, update) {
			const loop = {};
			loop.self = loop;
			update('before');
			update(loop);
			update('after');
			return Ok('untangled');
		},
	}),
} });
`;

/** A raw call's JSON lines. */
const linesOf = async (response: Response) =>
	(await response.text())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>);

test("a UI's call hears each update in order, then its answer; a raw call reads them as JSON lines; MCP gets only the answer", async () => {
	const f = await setup((f) => f.app('talk', talk));
	const heard: unknown[] = [];
	const client = connect<{ actions: { say: TalkSay } }>({
		app: 'talk',
		url: `${f.base}/`,
	});
	const said = await client.say(
		{ words: 'one two three' },
		{ onUpdate: (word) => heard.push(word) },
	);
	expect(expectOk(said)).toBe('one two three');
	expect(heard).toEqual(['one', 'two', 'three']);

	const raw = await fetch(`${f.base}/talk/say`, {
		method: 'POST',
		body: JSON.stringify({ words: 'a b' }),
	});
	expect(raw.status).toBe(200);
	expect(raw.headers.get('content-type')).toBe('application/x-ndjson');
	expect(await linesOf(raw)).toEqual([
		{ update: 'a' },
		{ update: 'b' },
		{ answer: { data: 'a b', error: null } },
	]);
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
	expect(body.result.structuredContent).toEqual({ data: 'x y', error: null });
});

test('a call serve never started answers NotStarted alone, as the body of a 400', async () => {
	const f = await setup(async (f) => {
		await f.app('talk', talk);
		await f.folder(join(f.apps, 'broken'), {
			'code/.gitignore': gitignore,
			'code/epicenter.ts': `import 'epicenter-acceptance-not-installed';\nexport default {};\n`,
		});
	});
	const post = (path: string, body: string) =>
		fetch(`${f.base}/${path}`, { method: 'POST', body });
	const notStarted = (fields: object) => ({
		data: null,
		error: {
			name: 'NotStarted',
			...fields,
			namespace: 'epicenter/action-error',
		},
	});
	for (const [path, body, fields] of [
		[
			'talk/sing',
			'{}',
			{
				message: 'talk has no action "sing"',
				cause: 'usage',
				next: 'epicenter talk',
			},
		],
		[
			'absent/say',
			'{}',
			{ message: 'Unknown app "absent"', cause: 'usage', next: 'epicenter' },
		],
		[
			'talk/say',
			'{"words":1}',
			{
				message: 'words must be text',
				cause: 'usage',
				next: 'epicenter talk say --help',
			},
		],
		[
			'talk/say',
			'[]',
			{ message: 'The input is not a JSON object', cause: 'usage' },
		],
		[
			'talk/say',
			'words',
			{ message: 'The input is not valid JSON', cause: 'usage' },
		],
		[
			'broken/x',
			'{}',
			{
				message: expect.stringMatching(/^broken: /),
				cause: 'app-problems',
				app: 'broken',
				problems: [expect.any(String)],
			},
		],
	] as const) {
		const response = await post(path, body);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual(notStarted(fields));
	}
	expect((await post('talk/say/extra', '{}')).status).toBe(404);
	const client = connect<{ actions: { sing: TalkSay } }>({
		app: 'talk',
		url: `${f.base}/`,
	});
	expect(expectErr(await client.sing({ words: 'la' })) as unknown).toEqual(
		notStarted({
			message: 'talk has no action "sing"',
			cause: 'usage',
			next: 'epicenter talk',
		}).error,
	);
	// The CLI reads the same refusal from serve and exits 2.
	const broken = await f.run('broken', 'x', '--json');
	expect(broken.code).toBe(2);
	expect(JSON.parse(broken.stdout)).toEqual(
		notStarted({
			message: expect.stringMatching(/^broken: /),
			cause: 'app-problems',
			app: 'broken',
			problems: [expect.any(String)],
		}),
	);
});

test('a caller that leaves stops reading; the action runs to its end and releases the lock', async () => {
	const f = await setup((f) => f.app('talk', talk));
	const leave = new AbortController();
	const response = await fetch(`${f.base}/talk/drip`, {
		method: 'POST',
		body: '{}',
		signal: leave.signal,
	});
	const reader = response.body?.getReader();
	const first = await reader?.read();
	expect(new TextDecoder().decode(first?.value)).toStartWith('{"update":0}');
	leave.abort();
	const data = join(f.apps, 'talk', 'data');
	const stopped = () => Bun.file(join(data, 'stopped.md')).exists();
	const deadline = Date.now() + 10_000;
	while (!(await stopped()) && Date.now() < deadline) await Bun.sleep(50);
	expect(await stopped()).toBe(true);
});

test('a listener that fails does not stop the action or the call', async () => {
	const f = await setup((f) => f.app('talk', talk));
	const client = connect<{
		actions: {
			drip: Action<Record<string, never>, Promise<Ok<string>>, number>;
		};
	}>({ app: 'talk', url: `${f.base}/` });
	const page = globalThis as { reportError?: (cause: unknown) => void };
	const original = page.reportError;
	const reported: unknown[] = [];
	page.reportError = (cause) => reported.push(cause);
	const bug = new Error('UI callback failed');
	try {
		const heard: number[] = [];
		const answer = await client.drip(
			{},
			{
				onUpdate: (count) => {
					heard.push(count);
					throw bug;
				},
			},
		);
		expect(expectOk(answer)).toBe('dripped');
		expect(heard).toEqual([0, 1, 2, 3, 4]);
		expect(reported).toEqual([bug, bug, bug, bug, bug]);
	} finally {
		page.reportError = original;
	}
});

test('an update that is not JSON is dropped alone, and the answer still arrives', async () => {
	const f = await setup((f) => f.app('talk', talk));
	const response = await fetch(`${f.base}/talk/tangle`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}',
	});
	expect(await linesOf(response)).toEqual([
		{ update: 'before' },
		{ update: 'after' },
		{ answer: { data: 'untangled', error: null } },
	]);
});

test('unserializable action throws still answer Threw, and preserve writes', async () => {
	const f = await setup((f) =>
		f.app(
			'failure',
			`
export default defineApp({ description: 'Failure', actions: {
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
	}
});

test('shared errors cross a real call after writes without claiming rollback or changing custom error depth', async () => {
	const f = await setup((f) =>
		f.app(
			'failures',
			`
import { ActionError } from '@epicenter/app';
export default defineApp({ description: 'Shared failures', actions: {
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
				NotStarted: ActionError.NotStarted({ message: 'Never began', cause: 'usage' }).error,
				PlainNotStarted: { name: 'NotStarted', message: 'Never began', cause: 'usage' },
				PlainUnreachable: { name: 'Unreachable', message: 'Lost' },
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
			'NotStarted',
			'PlainNotStarted',
			'PlainUnreachable',
			'Custom',
		]) {
			const error = expectErr(await client.fail({ kind, how }));
			const reserved = /^(Plain)?(NotStarted|Unreachable)$/.exec(kind);
			if (how === 'throw') {
				expect(error).toMatchObject({
					name: 'Threw',
					namespace: 'epicenter/action-error',
					thrown: {
						name:
							kind === 'Custom' ? 'ProposalChanged' : (reserved?.[2] ?? kind),
					},
				});
			} else if (reserved) {
				// Only Epicenter says a call never began or was lost, so an
				// action's own, with the namespace or without, answers Threw.
				expect(error).toEqual({
					name: 'Threw',
					message: `The action "fail" returned ${reserved[2]}, a name only Epicenter answers`,
					namespace: 'epicenter/action-error',
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
		const raw = await fetch(`${f.base}/failures/fail`, {
			method: 'POST',
			body: JSON.stringify({ kind: 'Missing', how }),
		});
		expect((await linesOf(raw)).at(-1)).toMatchObject({
			answer:
				how === 'return'
					? {
							data: null,
							error: {
								namespace: 'epicenter/action-error',
								name: 'Missing',
								message: 'There is no data/a.md',
								path: 'data/a.md',
							},
						}
					: {
							data: null,
							error: {
								name: 'Threw',
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

test('serve keeps nothing about a call: a second call runs the action again', async () => {
	const f = await setup((f) =>
		f.app(
			'counter',
			`export default defineApp({ description: 'Counter', actions: {
 bump: defineAction({ description: 'Count one more', input: {}, async run() {
  await folder.update('local/count', (value = '0') => String(Number(value) + 1));
  return Ok(null);
 } }),
} });`,
		),
	);
	for (const expected of ['1', '2']) {
		const response = await fetch(`${f.base}/counter/bump`, {
			method: 'POST',
			body: '{}',
		});
		expect(await linesOf(response)).toEqual([
			{ answer: { data: null, error: null } },
		]);
		expect(
			await readFile(join(f.apps, 'counter', 'local', 'count'), 'utf8'),
		).toBe(expected);
	}
	expect((await fetch(`${f.base}/.runs/counter/bump/x`)).status).toBe(404);
});

test('an edit to epicenter.ts, or to a file it imports, reaches the next call without restarting serve', async () => {
	const f = await setup((f) =>
		f.folder(join(f.apps, 'echo'), {
			'code/.gitignore': gitignore,
			'code/word.ts': "export const word = 'one';\n",
			'code/epicenter.ts': `${header}import { word } from './word.ts';
export default defineApp({ description: 'Echo', actions: {
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
		`${header}export default defineApp({ description: 'Echo', actions: {
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

test('a cross-origin call is refused before the action runs', async () => {
	const f = await setup();
	const response = await fetch(`${f.base}/reading/log`, {
		method: 'POST',
		headers: {
			origin: 'https://another.example',
			'content-type': 'application/json',
		},
		body: '{"minutes":5}',
	});
	expect(response.status).toBe(403);
	expect(await Bun.file(join(f.apps, 'reading', 'data')).exists()).toBe(false);
});

test('an update precedes a returned app refusal for UI and raw HTTP callers', async () => {
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
					onUpdate: (word) => {
						heard.push(word);
					},
				},
			),
		),
	).toEqual({ name: 'NoRoute', message: 'No route from LAX', airport: 'LAX' });
	expect(heard).toEqual(['checked']);
	const raw = await fetch(`${f.base}/talk/refuse`, {
		method: 'POST',
		body: '{}',
	});
	expect(raw.status).toBe(200);
	expect(await linesOf(raw)).toMatchObject([
		{ update: 'checked' },
		{
			answer: {
				data: null,
				error: { name: 'NoRoute', airport: 'LAX' },
			},
		},
	]);
});
