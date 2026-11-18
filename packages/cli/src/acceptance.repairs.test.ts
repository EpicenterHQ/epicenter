/**
 * Acceptance, stage 2c: the final review's repairs that outlived ADR-0850's
 * rewrite. Black-box runs of the real `epicenter` against a temporary HOME.
 * A run's answer is `{ result }`, `{ fault }`, or `{ error }`.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	connectMcp,
	fixture,
	gitignore,
	header,
	readingApp,
} from './runner.test-support.ts';

setDefaultTimeout(60_000);

const repo = resolve(import.meta.dir, '../../..');

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** An app whose actions each exercise one repair. */
const repairsCode = `${header}
export default defineApp({
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
});
`;

const repairsApp = {
	'code/.gitignore': gitignore,
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

test('F1 new puts the next step on stderr; a broken root is a usage error', async () => {
	const f = await setup();
	const made = await f.run('new', 'garden');
	expect(made.code).toBe(0);
	expect(made.stdout).toBe(`${join(f.apps, 'garden')}\n`);
	expect(made.stderr).toBe(
		`Run: cd ${f.home} && bun install && bun run build\n`,
	);
	await rm(f.home, { recursive: true });
	await writeFile(f.home, 'not a folder');
	const listed = await f.json();
	expect(listed.code).toBe(2);
	expect(listed.report.error.name).toBe('Usage');
});

test('F7 over MCP a broken app loses only its tools, and a call is decoded from the tool name', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), readingApp);
	await notes(f);
	await f.folder(join(f.apps, 'broken'), {
		'code/.gitignore': gitignore,
		'code/epicenter.ts': `import 'epicenter-acceptance-not-installed';\nexport default {};\n`,
	});
	await f.app(
		'loud',
		`console.log('noise while importing');
export default defineApp({ description: 'The loud app', actions: { hello: defineAction({ description: 'Say hello', input: {}, run: () => Ok('hello') }) } });
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
	for (const word of ['open', 'types', 'setup', 'help']) {
		const result = await f.json(word);
		expect(result.code).toBe(2);
		expect(result.report.error.message).toContain(`Unknown app "${word}"`);
	}
	for (const word of ['new', 'export', 'serve', 'init'])
		expect((await f.json('new', word)).code).toBe(2);
	expect((await f.json('new', 'link')).code).toBe(0);
	const help = (await f.run('--help')).stdout;
	expect(help).toContain(
		'Exit codes: 0 done, 1 failed or may have run, or an unfinished export, 2 did not run.',
	);
	for (const gone of [
		'epicenter types',
		'setup',
		'epicenter help',
		'epicenter build',
	])
		expect(help).not.toContain(gone);

	const leading = await f.run('--json', 'notes', 'two', '{"text":"Ada"}');
	expect(leading.code).toBe(0);
	expect(JSON.parse(leading.stdout)).toEqual({ data: 'Ada', error: null });
	expect(JSON.parse((await f.run('--json', 'notes')).stdout).name).toBe(
		'notes',
	);

	const tool = JSON.parse(
		(await f.run('notes', 'optional', '--help', '--json')).stdout,
	);
	expect(tool.inputSchema.required ?? []).not.toContain('count');
	const ran = await f.json('notes', 'optional');
	expect(ran.report.data).toEqual({});
	expect((await f.run('notes', 'optional', '--help')).stdout).toContain(
		'  count  optional  a number',
	);
});

test('F10 typing waits for its first consumer: no epicenter types, no generated file', async () => {
	const f = await setup();
	expect((await f.run('new', 'garden')).code).toBe(0);
	expect(
		await readFile(join(f.apps, 'garden', 'code/.gitignore'), 'utf8'),
	).toBe(gitignore);
	await f.app(
		'other',
		`export default defineApp({ description: 'Another app', actions: { hi: defineAction({ description: 'Hi', input: {}, run: () => Ok('hi') }) } });\n`,
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
	expect(existsSync(join(repo, 'packages/cli/src/types.ts'))).toBe(false);
});

test("F12 field.date() carries format: 'date', and the CLI reads the format", async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'reading'), readingApp);
	const tool = JSON.parse(
		(await f.run('reading', 'between', '--help', '--json')).stdout,
	);
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
