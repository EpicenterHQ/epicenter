/**
 * Acceptance tests for repairs a review made: a broken root, a broken app
 * over MCP, the command's vocabulary, typing, and date fields. Black-box runs
 * of the real `epicenter` against a temporary HOME. Every answer is
 * `{ data, error }`.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	connectMcp,
	fixture,
	header,
	readingApp,
} from './runner.test-support.ts';

setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** An app whose actions each exercise one repair. */
const repairsCode = `${header}
export default defineApp(({ folder }) => ({
	description: 'The notes app',
	actions: {
		two: defineAction({
			description: 'Write two files',
			input: { text: field.text() },
			run: async ({ text }) => {
				await folder.write('data/a.md', text);
				await folder.write('data/b.md', text);
				return Ok(text);
			},
		}),
		flags: defineAction({
			description: 'Report how this process was started',
			input: {},
			annotations: { readOnlyHint: true },
			run: () => Ok(process.execArgv),
		}),
		optional: defineAction({
			description: 'Take fields that may be absent',
			input: { count: field.number({ optional: true }), day: field.date({ optional: true }) },
			annotations: { readOnlyHint: true },
			run: (input) => Ok(input),
		}),
	},
}));
`;

const repairsApp = {
	'data/a.md': 'base a\n',
	'code/epicenter.ts': repairsCode,
};

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const json = async (...args: string[]) => {
		const result = await f.run(...args, '--json');
		return { ...result, report: JSON.parse(result.stdout) };
	};
	return { ...f, json };
}

/** The notes app in the home, as its own repository. */
function notes(f: Awaited<ReturnType<typeof setup>>) {
	return f.folder(join(f.apps, 'notes'), repairsApp);
}

test('F1 a broken root is a usage error', async () => {
	const f = await setup();
	await rm(f.home, { recursive: true });
	await writeFile(f.home, 'not a folder');
	const listed = await f.runIn(f.root, '--json').then((result) => ({
		...result,
		report: JSON.parse(result.stdout),
	}));
	expect(listed.code).toBe(2);
	expect(listed.report.error).toMatchObject({
		name: 'NotStarted',
		cause: 'usage',
	});
});

test('F7 over MCP a broken app loses only its tools, and a call is decoded from the tool name', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), readingApp);
	await notes(f);
	await f.folder(join(f.apps, 'broken'), {
		'code/epicenter.ts': `import 'epicenter-acceptance-not-installed';\nexport default {};\n`,
	});
	await f.app(
		'loud',
		`console.log('noise while importing');
export default defineApp(() => ({ description: 'The loud app', actions: { hello: defineAction({ description: 'Say hello', input: {}, run: () => Ok('hello') }) } }));
`,
	);
	const { client, close } = await connectMcp(f, ['--no-install']);
	try {
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).toContain('reading_log');
		expect(names).toContain('loud_hello');
		expect(names).toContain('notes_two');
		expect(names.some((name) => name.startsWith('broken_'))).toBe(false);

		const flags = await client.callTool({ name: 'notes_flags', arguments: {} });
		expect(flags.structuredContent).toMatchObject({
			data: expect.arrayContaining(['--no-install']),
			error: null,
		});
		const hello = await client.callTool({ name: 'loud_hello', arguments: {} });
		expect(hello.isError).toBeFalsy();
		expect(hello.structuredContent).toEqual({ data: 'hello', error: null });
		const unknown = await client.callTool({
			name: 'notes_nope',
			arguments: {},
		});
		expect(unknown.isError).toBe(true);
		expect(unknown.structuredContent).toMatchObject({
			data: null,
			error: { name: 'NotStarted', cause: 'usage' },
		});
		const broken = await client.callTool({ name: 'broken_x', arguments: {} });
		expect(broken.isError).toBe(true);
		expect(broken.structuredContent).toMatchObject({
			data: null,
			error: {
				name: 'NotStarted',
				cause: 'app-problems',
				problems: [expect.any(String)],
			},
		});
	} finally {
		await close();
	}
});

test('F9 one table owns the vocabulary; --json goes anywhere; optional fields are not required', async () => {
	const f = await setup();
	await notes(f);
	const help = (await f.run('--help')).stdout;
	expect(help).toContain(
		'Exit codes: 0 done, 1 failed, ran in part or may have run, 2 did not run.',
	);

	const leading = await f.run('--json', 'notes', 'two', '{"text":"Ada"}');
	expect(leading.code).toBe(0);
	expect(JSON.parse(leading.stdout)).toEqual({ data: 'Ada', error: null });
	expect(JSON.parse((await f.run('--json', 'notes')).stdout).data.name).toBe(
		'notes',
	);

	const tool = JSON.parse(
		(await f.run('notes', 'optional', '--help', '--json')).stdout,
	).data;
	expect(tool.inputSchema.required ?? []).not.toContain('count');
	const ran = await f.json('notes', 'optional');
	expect(ran.report.data).toEqual({});
	expect((await f.run('notes', 'optional', '--help')).stdout).toContain(
		'  count  optional  a number',
	);
});

test('F10 typing waits for its first consumer: no epicenter types, no generated file', async () => {
	const f = await setup();
	await f.app(
		'other',
		`export default defineApp(() => ({ description: 'Another app', actions: { hi: defineAction({ description: 'Hi', input: {}, run: () => Ok('hi') }) } }));\n`,
	);
	const listed = await f.json('other');
	expect(listed.code).toBe(0);
	expect(listed.report).not.toHaveProperty('notes');
	expect(JSON.stringify((await f.json()).report)).not.toContain(
		'epicenter.d.json.ts',
	);
	expect((await f.json('other', 'hi')).report).toEqual({
		data: 'hi',
		error: null,
	});
});

test("F12 field.date() carries format: 'date', and the CLI reads the format", async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), readingApp);
	const tool = JSON.parse(
		(await f.run('reading', 'between', '--help', '--json')).stdout,
	).data;
	expect(tool.inputSchema.properties.from).toEqual({
		type: 'string',
		format: 'date',
	});
	expect((await f.run('reading', 'between', '-h')).stdout).toContain(
		'  from  required  a day like 2026-11-12',
	);
	const bad = await f.json(
		'reading',
		'between',
		'{"from":"2026-13-45","to":"2026-11-08"}',
	);
	expect(bad.code).toBe(2);
	expect(bad.report.error.message).toBe('from must be a day like 2026-11-12');
});
