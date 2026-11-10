/**
 * Acceptance, stage 1: what an app's epicenter.ts declares (ADR-0857, ADR-0849, ADR-0853).
 * Black-box runs of the real `epicenter` against a temporary HOME.
 */

import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, gitIn, readingApp } from './runner.test-support.ts';

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
const words = `const words = defineCollection({ path: 'words/{stem}.md', fields: { stage: field.select(['new', 'known']) } });\n`;

const MCP_DEFAULTS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
};

test('D1 the listing shows folders with an epicenter.ts, ignores the rest, and names each problem', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), readingApp);
	await f.app(
		'vocab',
		`${words}export default defineApp({ description: 'The vocab app', collections: { words }, actions: {} });\n`,
	);
	const linked = await f.app(
		'journal',
		`export default defineApp({ description: 'The journal app', collections: {}, actions: {} });\n`,
		join(f.root, 'elsewhere'),
	);
	await symlink(linked, join(f.home, 'journal'));
	await f.folder(join(f.home, 'readme-only'), { 'README.md': 'not an app\n' });
	await f.folder(join(f.home, 'json-only'), {
		'epicenter.json': JSON.stringify({ description: 'Before epicenter.ts' }),
	});
	await f.app(
		'clash',
		`${words}export default defineApp({
	description: 'The clash app',
	collections: { words },
	actions: {
		...words.actions(),
		set: defineAction({ description: 'Save a word my way', input: { stem: field.text() }, positional: ['stem'], run: ({ stem }) => \`mine: \${stem}\` }),
	},
});
`,
	);
	await f.app(
		'malformed',
		`const words = defineCollection({ path: 'words/{word}.md', fields: { word: field.text(), path: field.text() } });
export default defineApp({ description: 'The malformed app', collections: { words }, actions: {} });
`,
	);
	await f.app(
		'misplaced',
		`const show = defineAction({ description: 'Show', input: {}, positional: ['nope'], run: () => 1 });
export default defineApp({ description: 'The misplaced app', collections: {}, actions: { show } });
`,
	);
	await f.app('badpath', `defineCollection({ path: 'words/', fields: {} });\n`);
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
		badpath: ['epicenter.ts: The collection path words/ is not a .md path'],
		malformed: [
			'epicenter.ts: The collection at words/{word}.md has a field "word", which its path gives as {word}; the file\'s name holds it',
			'epicenter.ts: The collection at words/{word}.md has a field "path", which is the file\'s address',
		],
		misplaced: [
			'epicenter.ts: The action "Show" has the positional "nope", which is not one of its fields',
		],
		nodefault: ['epicenter.ts does not export defineApp(...) by default'],
		nullactions: [
			'epicenter.ts: An app needs actions: an object of defineAction(...) and groups of them, {} for none',
		],
		shapeless: [
			'epicenter.ts: collections.words is not defineCollection(...)',
			'epicenter.ts: actions.show is neither an action nor a group of them',
		],
		unchecked: [
			'epicenter.ts: actions.show is not an action: make it with defineAction(...), and change one with defineAction({ ... }) rather than a spread, which drops the call',
		],
	});
	// A later key replaces an earlier one: the written set replaces the collection's.
	const clash = await f.run('clash', 'set', 'serendipity');
	expect(clash.stdout).toBe('mine: serendipity\n');
	expect(JSON.stringify(listing)).not.toContain('readme-only');
	expect(JSON.stringify(listing)).not.toContain('json-only');

	const human = await f.run();
	expect(human.stdout).toMatch(/^vocab +The vocab app$/m);
	expect(human.stdout).toContain(`-> ${linked}`);
	expect(human.stdout).toContain('Problems:');
	expect(human.stdout).toContain(
		'    epicenter.ts: The collection path words/ is not a .md path',
	);
});

test('D2 --json prints the app from epicenter.ts, each action an MCP tool', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), readingApp);
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
		folder: join(f.home, 'reading'),
		collections: {
			books: {
				path: 'books/{slug}.md',
				fields: { properties: { title: { type: 'string' } } },
			},
		},
	});
	expect(reading.actions.map((tool: { name: string }) => tool.name)).toEqual([
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
	expect(reading.actions[6]).toEqual({
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
	expect(reading.actions[8].annotations).toEqual({
		...MCP_DEFAULTS,
		readOnlyHint: true,
		openWorldHint: false,
	});
	expect(reading.actions[0].description).toBe(
		'Every books/{slug}.md file: its path and fields, and the problems of one that does not fit them',
	);
	expect(JSON.stringify(listing)).not.toContain('positional');
	const vocab = listing.apps.find(
		(app: { name: string }) => app.name === 'vocab',
	);
	expect(vocab.collections).toEqual({
		words: {
			path: 'words/{stem}.md',
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

test("D3 positionals come from the action's ordered list; flags always work", async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), readingApp);
	const logged = await f.run('reading', 'log', '30', '--book', 'Dune');
	expect(logged.code).toBe(0);
	expect(logged.stdout).toBe('minutes: 30\nbook: Dune\n');
	expect(await readFile(join(f.home, 'reading/2026.csv'), 'utf8')).toBe(
		'minutes,book\n30,Dune\n',
	);
	const both = await f.run('reading', 'between', '2026-11-01', '2026-11-08');
	expect(both.stdout).toBe('from: 2026-11-01\nto: 2026-11-08\n');
	const flags = await f.run(
		'reading',
		'between',
		'--to',
		'2026-11-08',
		'--from',
		'2026-11-01',
	);
	expect(flags.stdout).toBe(both.stdout);
	const mixed = await f.run(
		'reading',
		'between',
		'--from',
		'2026-11-01',
		'2026-11-08',
	);
	expect(mixed.stdout).toBe(both.stdout);
	const extra = await f.run(
		'reading',
		'between',
		'2026-11-01',
		'2026-11-08',
		'2026-11-09',
	);
	expect(extra.code).toBe(2);
	expect(extra.stderr).toContain('2026-11-09');
	const help = await f.run('reading', 'between', '--help');
	expect(help.stdout).toContain('epicenter reading between <from> <to>');
});

test('D5 an epicenter.ts importing @epicenter/app loads from a folder with no node_modules', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	expect(existsSync(join(folder, 'node_modules'))).toBe(false);
	const result = await f.runIn(folder, 'reading', 'log', '12');
	expect(result.code).toBe(0);
	expect(result.stdout).toBe('minutes: 12\nbook: null\n');
	expect(await readFile(join(folder, '2026.csv'), 'utf8')).toBe(
		'minutes,book\n12,\n',
	);
});

test('D6 serve --stdio answers initialize, lists the same tools as --json, and runs a call', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	const listing = JSON.parse((await f.run('--json')).stdout);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [f.bin, 'serve', '--stdio'],
		cwd: f.root,
		env: f.env as Record<string, string>,
		stderr: 'pipe',
	});
	const client = new Client({ name: 'acceptance', version: '1' });
	try {
		await client.connect(transport);
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
		expect(await gitIn(folder, 'log', '-1', '--format=%s')).toBe(
			'reading: log 30',
		);
		expect(await readFile(join(folder, '2026.csv'), 'utf8')).toBe(
			'minutes,book\n30,\n',
		);
	} finally {
		await client.close();
	}
	expect((await f.run('mcp')).code).toBe(2);
});

test('D7 discovery defaults to $HOME/Epicenter and ignores EPICENTER_HOME', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), readingApp);
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
	path: 'items/{id}.md',
	fields: {
		kind: field.select(['thought', 'link', 'quote']),
		url: field.text({ optional: true }),
		added: field.date(),
	},
});

export default defineApp({
	description: 'Things I want to keep',
	collections: { items },
	actions: items.actions(),
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
	expect(help.stdout).toContain(
		'epicenter capture add <id> --kind <thought|link|quote> [--url <text>] --added <date> [--body <text>]',
	);

	expect(
		await json(
			'add',
			'dune',
			'--kind',
			'quote',
			'--added',
			'2026-11-09',
			'--body',
			'Fear is the mind-killer.\n',
		),
	).toEqual({
		code: 0,
		answer: {
			returned: {
				path: 'items/dune.md',
				id: 'dune',
				kind: 'quote',
				added: '2026-11-09',
				body: 'Fear is the mind-killer.\n',
			},
		},
	});
	expect(await readFile(join(folder, 'items/dune.md'), 'utf8')).toBe(
		'---\nkind: "quote"\nadded: "2026-11-09"\n---\nFear is the mind-killer.\n',
	);

	// Refused before anything is written: by the command line (2) or by the collection (1).
	const refused = [
		[
			['set', 'items/dune.md', '--kind', 'poem'],
			2,
			'--kind must be one of: thought, link, quote',
		],
		[
			['set', 'items/dune.md', '--added', '2026-13-45'],
			2,
			'--added needs a day, as 2026-11-12',
		],
		[['add', 'new-one', '--kind', 'link'], 2, '--added is needed'],
		[
			['add', 'dune', '--kind', 'link', '--added', '2026-11-09'],
			1,
			'items/dune.md is already there',
		],
		[
			['add', '..', '--kind', 'link', '--added', '2026-11-09'],
			2,
			"<id> must be a file's name for {id} in items/{id}.md: no / or \\\\, and not starting with .",
		],
		[
			['set', 'items/new-one.md', '--kind', 'link'],
			1,
			'There is no items/new-one.md',
		],
		[
			['set', 'notes/dune.md', '--kind', 'link'],
			1,
			'notes/dune.md is not a file at items/{id}.md',
		],
		[
			['set', 'items/dune.md', '--kind', 'null'],
			2,
			'--kind does not take null',
		],
		[['set', '--input', '{"path":"items/dune.md","added":null}'], 2, 'added'],
	] as const;
	for (const [args, code, message] of refused) {
		const result = await json(...args);
		expect(result.code).toBe(code);
		expect(JSON.stringify(result.answer)).toContain(message);
	}
	expect(await readFile(join(folder, 'items/dune.md'), 'utf8')).toContain(
		'kind: "quote"',
	);

	expect(
		(await json('set', 'items/dune.md', '--url', 'https://example.com/dune'))
			.code,
	).toBe(0);
	expect(
		(
			await json(
				'edit',
				'items/dune.md',
				'--old',
				'mind-killer',
				'--new',
				'little-death',
			)
		).code,
	).toBe(0);
	expect(await json('list')).toEqual({
		code: 0,
		answer: {
			returned: [
				{
					path: 'items/dune.md',
					id: 'dune',
					kind: 'quote',
					url: 'https://example.com/dune',
					added: '2026-11-09',
				},
			],
		},
	});
	expect((await f.run('capture', 'get', 'items/dune.md')).stdout).toBe(
		'path: items/dune.md\nid: dune\nkind: quote\nurl: https://example.com/dune\nadded: 2026-11-09\nbody: |\n  Fear is the little-death.\n',
	);

	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [f.bin, 'serve', '--stdio'],
		cwd: f.root,
		env: f.env as Record<string, string>,
		stderr: 'pipe',
	});
	const client = new Client({ name: 'acceptance', version: '1' });
	try {
		await client.connect(transport);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			'capture_list',
			'capture_get',
			'capture_add',
			'capture_set',
			'capture_edit',
			'capture_delete',
		]);
		expect(tools[5]?.annotations).toEqual({
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
			arguments: { path: 'items/petrichor.md', kind: 'poem' },
		});
		expect(bad.isError).toBe(true);
		const deleted = await client.callTool({
			name: 'capture_delete',
			arguments: { path: 'items/dune.md' },
		});
		expect(deleted.structuredContent).toEqual({
			returned: true,
		});
	} finally {
		await client.close();
	}
	expect(await json('list')).toEqual({
		code: 0,
		answer: {
			returned: [
				{
					path: 'items/petrichor.md',
					id: 'petrichor',
					kind: 'thought',
					added: '2026-11-09',
				},
			],
		},
	});
	// Every write is its own commit, named for the call, from the terminal and MCP alike.
	expect(await gitIn(folder, 'log', '--format=%s')).toBe(
		[
			'capture: delete items/dune.md',
			'capture: add petrichor',
			'capture: edit items/dune.md',
			'capture: set items/dune.md',
			'capture: add dune',
			'initial',
		].join('\n'),
	);
});
