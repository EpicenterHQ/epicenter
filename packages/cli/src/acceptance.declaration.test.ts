/**
 * Acceptance, stage 1: what an app's epicenter.ts declares (ADR-0857, ADR-0849, ADR-0853).
 * Black-box runs of the real `epicenter` against a temporary HOME.
 */

import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectMcp, fixture, readingApp } from './runner.test-support.ts';

setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	return f;
}

/** Vocab's words collection, as epicenter.ts source. */
const words = `const words = defineCollection({ path: 'data/words/{stem}.md', fields: { stage: field.select(['new', 'known']) } });\n`;

const MCP_DEFAULTS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
};

test('D1 the listing shows folders with an epicenter.ts, ignores the rest, and names each problem', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), readingApp);
	await f.app(
		'vocab',
		`${words}export default defineApp({ description: 'The vocab app', collections: { words }, actions: {} });\n`,
	);
	const linked = await f.app(
		'journal',
		`export default defineApp({ description: 'The journal app', collections: {}, actions: {} });\n`,
		join(f.root, 'elsewhere'),
	);
	await symlink(linked, join(f.apps, 'journal'));
	await f.folder(join(f.apps, 'readme-only'), { 'README.md': 'not an app\n' });
	await f.folder(join(f.apps, 'json-only'), {
		'epicenter.json': JSON.stringify({ description: 'Before epicenter.ts' }),
	});
	await f.app(
		'clash',
		`${words}export default defineApp({
	description: 'The clash app',
	collections: { words },
	actions: {
		...words.actions(),
		set: defineAction({ description: 'Save a word my way', input: { stem: field.text() }, run: ({ stem }) => Ok(\`mine: \${stem}\`) }),
	},
});
`,
	);
	await f.app(
		'malformed',
		`const words = defineCollection({ path: 'data/words/{word}.md', fields: { word: field.text(), path: field.text() } });
export default defineApp({ description: 'The malformed app', collections: { words }, actions: {} });
`,
	);
	await f.app(
		'misplaced',
		`const show = defineAction({ description: 'Show', input: {}, positional: ['nope'], run: () => Ok(1) });
export default defineApp({ description: 'The misplaced app', collections: {}, actions: { show } });
`,
	);
	await f.app(
		'badpath',
		`defineCollection({ path: 'data/words/', fields: {} });\n`,
	);
	await f.app(
		'unchecked',
		`export default defineApp({ description: 'The unchecked app', collections: {}, actions: { show: { description: 'Show', input: {}, run: () => 1 } } });\n`,
	);
	await f.app('nodefault', `export const actions = {};\n`);
	// Exported without defineApp, so nothing checked it while importing.
	await f.app(
		'nullactions',
		`export default { description: 'Unchecked', collections: {}, actions: null };\n`,
	);
	await f.app(
		'shapeless',
		`export default { description: 'Unchecked', collections: { words: {} }, actions: { show: 5 } };\n`,
	);

	const result = await f.run('--json');
	expect(result.code).toBe(0);
	const listing = JSON.parse(result.stdout);
	expect(listing.epicenter).toBe(f.home);
	expect(listing.apps.map((app: { name: string }) => app.name)).toEqual([
		'clash',
		'journal',
		'reading',
		'vocab',
	]);
	expect(
		listing.apps.find((app: { name: string }) => app.name === 'journal').link,
	).toBe(linked);
	const problems = Object.fromEntries(
		listing.problems.map((entry: { entry: string; problems: string[] }) => [
			entry.entry,
			entry.problems,
		]),
	);
	expect(problems).toEqual({
		// Each line of what a define call throws is one problem.
		badpath: [
			'code/epicenter.ts: The collection path data/words/ is not a .md path',
		],
		malformed: [
			'code/epicenter.ts: The collection at data/words/{word}.md has a field "word", which its path gives as {word}; the file\'s name holds it',
			'code/epicenter.ts: The collection at data/words/{word}.md has a field "path", which is the file\'s address',
		],
		misplaced: [
			'code/epicenter.ts: The action "Show" has "positional", which an action no longer takes: the command line reads its input as one JSON object, so delete the line',
		],
		nodefault: ['code/epicenter.ts does not export defineApp(...) by default'],
		nullactions: [
			'code/epicenter.ts: An app needs actions: an object of defineAction(...) and groups of them, {} for none',
		],
		shapeless: [
			'code/epicenter.ts: collections.words is not defineCollection(...)',
			'code/epicenter.ts: actions.show is neither an action nor a group of them',
		],
		unchecked: [
			'code/epicenter.ts: actions.show is not an action: make it with defineAction(...), and change one with defineAction({ ... }) rather than a spread, which drops the call',
		],
	});
	// A later key replaces an earlier one: the written set replaces the collection's.
	const clash = await f.run('clash', 'set', '{"stem":"serendipity"}');
	expect(clash.stdout).toBe('mine: serendipity\n');
	expect(JSON.stringify(listing)).not.toContain('readme-only');
	expect(JSON.stringify(listing)).not.toContain('json-only');

	const human = await f.run();
	expect(human.stdout).toMatch(/^vocab +The vocab app$/m);
	expect(human.stdout).toContain(`-> ${linked}`);
	expect(human.stdout).toContain('Problems:');
	expect(human.stdout).toContain(
		'    code/epicenter.ts: The collection path data/words/ is not a .md path',
	);
});

test('D2 --json prints the app from epicenter.ts, each action an MCP tool', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), readingApp);
	await f.app(
		'vocab',
		`${words}export default defineApp({ description: 'The vocab app', collections: { words }, actions: {} });\n`,
	);
	const listing = JSON.parse((await f.run('--json')).stdout);
	const reading = listing.apps.find(
		(app: { name: string }) => app.name === 'reading',
	);
	expect(reading).toMatchObject({
		name: 'reading',
		description: 'How much I read each week',
		folder: join(f.apps, 'reading'),
		collections: {
			books: {
				path: 'data/books/{slug}.md',
				fields: { properties: { title: { type: 'string' } } },
			},
		},
	});
	expect(reading.actions.map((tool: { name: string }) => tool.name)).toEqual([
		'reading_books_list',
		'reading_books_get',
		'reading_books_add',
		'reading_books_set',
		'reading_log',
		'reading_between',
		'reading_week_show',
		'reading_explode',
	]);
	expect(reading.actions[4]).toEqual({
		name: 'reading_log',
		description: 'Record minutes read today',
		inputSchema: {
			type: 'object',
			properties: { minutes: { type: 'number' }, book: { type: 'string' } },
			required: ['minutes'],
			additionalProperties: false,
		},
		annotations: MCP_DEFAULTS,
	});
	expect(reading.actions[6].annotations).toEqual({
		...MCP_DEFAULTS,
		readOnlyHint: true,
		openWorldHint: false,
	});
	expect(reading.actions[0].description).toBe(
		'Every data/books/{slug}.md file: one result per file with its path and fields; a file that does not fit its fields is an error beside the rows',
	);
	expect(JSON.stringify(listing)).not.toContain('positional');
	const vocab = listing.apps.find(
		(app: { name: string }) => app.name === 'vocab',
	);
	expect(vocab.collections).toEqual({
		words: {
			path: 'data/words/{stem}.md',
			fields: {
				type: 'object',
				properties: {
					stage: {
						anyOf: [
							{ const: 'new', type: 'string' },
							{ const: 'known', type: 'string' },
						],
					},
				},
				required: ['stage'],
				additionalProperties: false,
			},
		},
	});
	expect(vocab.actions).toEqual([]);
	const one = JSON.parse((await f.run('reading', '--json')).stdout);
	expect(one.name).toBe('reading');
	expect(one).not.toHaveProperty('keychain');
	expect(one.actions).toEqual(reading.actions);
});

test("D3 the input is one JSON object after the action's words, or - to read it from stdin", async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), readingApp);
	/** Run with stdin open: `text` is written to it, and it is closed only when `close` is true. */
	const piped = async (text: string, close: boolean, ...args: string[]) => {
		const child = Bun.spawn([process.execPath, f.bin, ...args], {
			cwd: f.root,
			env: f.env,
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		child.stdin.write(text);
		if (close) child.stdin.end();
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (!close) child.stdin.end();
		return { stdout, stderr, code };
	};

	const logged = await f.run('reading', 'log', '{"minutes":30,"book":"Dune"}');
	expect(logged).toEqual({
		code: 0,
		stdout: 'minutes: 30\nbook: Dune\n',
		stderr: '',
	});
	expect(await readFile(join(f.apps, 'reading/data/2026.csv'), 'utf8')).toBe(
		'minutes,book\n30,Dune\n',
	);
	// `--json` and `--help` are the command's own, before or after the input.
	const between = '{"from":"2026-11-01","to":"2026-11-08"}';
	const both = await f.run('reading', 'between', between);
	expect(both.stdout).toBe('from: 2026-11-01\nto: 2026-11-08\n');
	expect((await f.run('reading', '--json', 'between', between)).stdout).toBe(
		(await f.run('reading', 'between', between, '--json')).stdout,
	);

	// `-` reads all of stdin as the JSON text.
	expect(
		await piped(`${between}\n`, true, 'reading', 'between', '-'),
	).toMatchObject({ code: 0, stdout: both.stdout });
	// Stdin is read only for `-`: held open, it neither hangs nor is read.
	expect(
		await piped('{"from":"2000-01-01"}', false, 'reading', 'between', between),
	).toMatchObject({ code: 0, stdout: both.stdout });
	expect(
		await piped('{"minutes":5}', false, 'reading', 'week', 'show'),
	).toMatchObject({ code: 0, stdout: '210\n' });

	for (const [args, message] of [
		[['between', '2026-11-01', '2026-11-08'], 'The input is one argument'],
		[['between', '--from', '2026-11-01'], 'The input is one argument'],
		[['between', '--input', between], 'The input is one argument'],
		[['between', '2026-11-01'], 'The input is not JSON'],
		[['between', '[]'], 'The input is not a JSON object'],
		[['between', '{"from":"2026-11-01"}'], 'to is needed'],
		[['week', 'show', '{"day":1}'], '"day" is not a key this action takes'],
	] as const) {
		const refused = await f.run('reading', ...args, '--json');
		expect(refused.code).toBe(2);
		expect(JSON.parse(refused.stdout).error.reason.message).toContain(message);
	}

	const help = await f.run('reading', 'between', '--help');
	expect(help.stdout).toBe(`epicenter reading between <input>
Minutes read between two days

Input, one JSON object, or - to read it from stdin:
  from  required  a day like 2026-11-12
  to    required  a day like 2026-11-12

Example:
  epicenter reading between '{"from":"2026-11-12","to":"2026-11-12"}'
`);
	expect((await f.run('reading', 'week', 'show', '--help')).stdout).toBe(
		'epicenter reading week show\nMinutes read this week\n',
	);
});

test('D5 an epicenter.ts importing @epicenter/app loads from a folder with no node_modules', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.apps, 'reading'), readingApp);
	expect(existsSync(join(folder, 'node_modules'))).toBe(false);
	const result = await f.runIn(folder, 'reading', 'log', '{"minutes":12}');
	expect(result.code).toBe(0);
	expect(result.stdout).toBe('minutes: 12\nbook: null\n');
	expect(await readFile(join(folder, 'data/2026.csv'), 'utf8')).toBe(
		'minutes,book\n12,\n',
	);
});

test('D6 serve answers initialize, lists the same tools as --json, and runs a call', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.apps, 'reading'), readingApp);
	const listing = JSON.parse((await f.run('--json')).stdout);
	const { client, close } = await connectMcp(f);
	try {
		expect(client.getServerVersion()?.name).toBe('epicenter');
		const { tools } = await client.listTools();
		expect(tools).toEqual(
			listing.apps.flatMap((app: { actions: unknown[] }) => app.actions),
		);
		const called = await client.callTool({
			name: 'reading_log',
			arguments: { minutes: 30 },
		});
		expect(called.isError).toBeFalsy();

		expect(await readFile(join(folder, 'data/2026.csv'), 'utf8')).toBe(
			'minutes,book\n30,\n',
		);
	} finally {
		await close();
	}
	expect((await f.run('mcp')).code).toBe(2);
});

test('D7 discovery defaults to $HOME/Epicenter and ignores EPICENTER_HOME', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), readingApp);
	const decoy = join(f.root, 'decoy-home');
	await f.app(
		'decoy',
		`export default defineApp({ description: 'The decoy app', collections: {}, actions: {} });\n`,
		decoy,
	);
	f.env.EPICENTER_HOME = decoy;
	const listing = JSON.parse((await f.run('--json')).stdout);
	expect(listing.epicenter).toBe(join(f.root, 'Epicenter'));
	expect(listing.apps.map((app: { name: string }) => app.name)).toEqual([
		'reading',
	]);
	expect((await f.run('--help')).stdout).not.toContain('EPICENTER_HOME');
});

/** Capture: an app whose actions are only its one collection's verbs. */
const capture = `const items = defineCollection({
	path: 'data/items/{id}.md',
	fields: {
		kind: field.select(['thought', 'link', 'quote']),
		url: field.text({ optional: true }),
		added: field.date(),
	},
});

export default defineApp({
	description: 'Things I want to keep',
	collections: { items },
	actions: { ...items.actions(), ...items.actions('delete') },
});
`;

test("D8 an app of one collection's verbs adds, reads, changes, and deletes its files from the terminal and MCP", async () => {
	const f = await setup();
	const folder = await f.app('capture', capture);
	const json = async (...args: string[]) => {
		const result = await f.run('capture', ...args, '--json');
		return { code: result.code, answer: JSON.parse(result.stdout) };
	};

	const help = await f.run('capture', 'add', '--help');
	expect(help.stdout).toContain('epicenter capture add <input>');
	expect(help.stdout).toContain(
		'  kind   required  one of thought, link, quote',
	);
	expect(help.stdout).toContain(
		`epicenter capture add '{"id":"text","kind":"thought","added":"2026-11-12"}'`,
	);

	expect(
		await json(
			'add',
			JSON.stringify({
				id: 'dune',
				kind: 'quote',
				added: '2026-11-09',
				body: 'Fear is the mind-killer.\n',
			}),
		),
	).toEqual({
		code: 0,
		answer: {
			data: {
				path: 'data/items/dune.md',
				id: 'dune',
				kind: 'quote',
				added: '2026-11-09',
				body: 'Fear is the mind-killer.\n',
			},
			error: null,
		},
	});
	expect(await readFile(join(folder, 'data/items/dune.md'), 'utf8')).toBe(
		'---\nkind: "quote"\nadded: "2026-11-09"\n---\nFear is the mind-killer.\n',
	);

	// Refused before anything is written: by the command line (2) or by the collection (1).
	const refused = [
		[
			['set', { id: 'dune', kind: 'poem' }],
			2,
			'kind must be one of thought, link, quote',
		],
		[
			['set', { id: 'dune', added: '2026-13-45' }],
			2,
			'added must be a day like 2026-11-12',
		],
		[['add', { id: 'new-one', kind: 'link' }], 2, 'added is needed'],
		[
			['add', { id: 'dune', kind: 'link', added: '2026-11-09' }],
			1,
			'data/items/dune.md is already there',
		],
		[
			['add', { id: '..', kind: 'link', added: '2026-11-09' }],
			2,
			"id must be a file's name for {id} in data/items/{id}.md: no / or \\\\, and not starting with .",
		],
		[
			['set', { id: 'new-one', kind: 'link' }],
			1,
			'There is no data/items/new-one.md',
		],
		[['set', { id: 'a\\b', kind: 'link' }], 1, 'cannot name a file'],
		[['set', { id: 'dune', kind: null }], 2, 'kind'],
		[['set', { id: 'dune', added: null }], 2, 'added'],
		[['set', { id: 'dune', knd: 'link' }], 2, 'is not a key this action takes'],
	] as const;
	for (const [[verb, input], code, message] of refused) {
		const result = await json(verb, JSON.stringify(input));
		expect(result.code).toBe(code);
		expect(JSON.stringify(result.answer)).toContain(message);
	}
	expect(await readFile(join(folder, 'data/items/dune.md'), 'utf8')).toContain(
		'kind: "quote"',
	);
	// A passage names the record it did not find.
	expect(
		await f.run(
			'capture',
			'set',
			'{"id":"new-one","edit":{"old":"","new":"x"}}',
		),
	).toEqual({
		code: 1,
		stdout: '',
		stderr: 'There is no data/items/new-one.md\n',
	});

	expect(
		(await json('set', '{"id":"dune","url":"https://example.com/dune"}')).code,
	).toBe(0);
	expect(
		(
			await json(
				'set',
				'{"id":"dune","edit":{"old":"mind-killer","new":"little-death"}}',
			)
		).code,
	).toBe(0);
	expect(await json('list')).toEqual({
		code: 0,
		answer: {
			data: [
				{
					data: {
						path: 'data/items/dune.md',
						id: 'dune',
						kind: 'quote',
						url: 'https://example.com/dune',
						added: '2026-11-09',
					},
					error: null,
				},
			],
			error: null,
		},
	});
	await writeFile(
		join(folder, 'data/items/broken.md'),
		'---\nkind: "poem"\nadded: "2026-11-09"\n---\nsecret body\n',
	);
	const mixed = await json('list');
	expect(mixed.code).toBe(0);
	expect(mixed.answer.error).toBeNull();
	const rows = mixed.answer.data;
	expect(rows).toHaveLength(2);
	expect(rows[0]).toMatchObject({
		data: null,
		error: {
			name: 'Misfit',
			path: 'data/items/broken.md',
			record: { id: 'broken', added: '2026-11-09' },
		},
	});
	expect(Array.isArray(rows[0].error.problems)).toBe(true);
	expect(rows[0].error.problems.length).toBeGreaterThan(0);
	expect(rows[0].error.record).not.toHaveProperty('body');
	expect(rows[1]).toMatchObject({
		data: { path: 'data/items/dune.md' },
		error: null,
	});
	expect(JSON.stringify(mixed)).not.toContain('secret body');
	const misfit = await json('get', '{"id":"broken"}');
	expect(misfit.code).toBe(1);
	expect(misfit.answer.error.reason.name).toBe('Misfit');
	const missing = await json('get', '{"id":"nope"}');
	expect(missing.code).toBe(1);
	expect(missing.answer.error.reason.name).toBe('Missing');
	await rm(join(folder, 'data/items/broken.md'));
	expect((await f.run('capture', 'get', '{"id":"dune"}')).stdout).toBe(
		'path: data/items/dune.md\nid: dune\nkind: quote\nurl: https://example.com/dune\nadded: 2026-11-09\nbody: |\n  Fear is the little-death.\n',
	);

	const { client, close } = await connectMcp(f);
	try {
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			'capture_list',
			'capture_get',
			'capture_add',
			'capture_set',
			'capture_delete',
		]);
		expect(tools[4]?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
		const added = await client.callTool({
			name: 'capture_add',
			arguments: { id: 'petrichor', kind: 'thought', added: '2026-11-09' },
		});
		expect(added.isError).toBeFalsy();
		const bad = await client.callTool({
			name: 'capture_set',
			arguments: { id: 'petrichor', kind: 'poem' },
		});
		expect(bad.isError).toBe(true);
		const deleted = await client.callTool({
			name: 'capture_delete',
			arguments: { id: 'dune' },
		});
		expect(deleted.structuredContent).toEqual({ data: true, error: null });
	} finally {
		await close();
	}
	expect(await json('list')).toEqual({
		code: 0,
		answer: {
			data: [
				{
					data: {
						path: 'data/items/petrichor.md',
						id: 'petrichor',
						kind: 'thought',
						added: '2026-11-09',
					},
					error: null,
				},
			],
			error: null,
		},
	});
});

test('D9 keyless collection is one record even before its file exists', async () => {
	const f = await setup();
	await f.app(
		'prefs',
		`const settings = defineCollection({ path: 'data/settings.md', fields: { goal: field.integer({optional:true}) } });
export default defineApp({ description: 'Preferences', collections: { settings }, actions: { settings: settings.actions() } });
`,
	);
	const before = await f.run('prefs', 'settings', 'get', '--json');
	expect(before.code).toBe(0);
	const answer = JSON.parse(before.stdout);
	expect(answer.error).toBeNull();
	expect(answer.data.path).toBe('data/settings.md');
	expect(answer.data).not.toHaveProperty('goal');
	expect((await f.run('prefs', 'settings', 'add', '{"goal":3}')).code).toBe(2);
	await f.app(
		'badprefs',
		`const settings=defineCollection({path:'data/settings.md',fields:{goal:field.integer()}});export default defineApp({description:'Bad preferences',collections:{settings},actions:{settings:settings.actions()}});`,
	);
	expect((await f.run('badprefs', 'settings', 'get', '--json')).code).toBe(2);
	expect(await f.run('prefs', 'settings', 'set', '{"goal":4}')).toEqual({
		code: 0,
		stdout: 'path: data/settings.md\ngoal: 4\nbody: ""\n',
		stderr: '',
	});
	expect((await f.run('prefs', 'settings', 'add', '{"goal":3}')).code).toBe(2);
	expect((await f.run('prefs', 'settings', 'set', '{"goal":5}')).code).toBe(0);
	expect((await f.run('prefs', 'settings', 'get')).stdout).toBe(
		'path: data/settings.md\ngoal: 5\nbody: ""\n',
	);
});
