/**
 * Acceptance, stage 2c: the final review's repairs that outlived ADR-0850's
 * rewrite. Black-box runs of the real `epicenter` against a temporary HOME.
 * A run's answer is `{ returned }`, `{ threw }`, or `{ error }`.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
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

/** An app whose actions each exercise one repair; signals pause an action at a known point. */
const repairsCode = `${header}
const until = async (path: string) => {
	while (!(await Bun.file(path).exists())) await Bun.sleep(10);
};

export default defineApp({
	description: 'The notes app',
	collections: {},
	actions: {
		two: defineAction({
			description: 'Write two files',
			input: { text: field.text() },
			positional: ['text'],
			run: async ({ text }) => {
				await folder.write('data/a.md', text);
				await folder.write('data/b.md', text);
				return text;
			},
		}),
		orphan: defineAction({
			description: 'Leave the parent pid, wait for a signal, then write data/a.md',
			input: { signals: field.text() },
			run: async ({ signals }) => {
				await Bun.write(signals + '/parent', String(process.ppid));
				await until(signals + '/go');
				await folder.write('data/a.md', 'finished without a parent');
			},
		}),
		flags: defineAction({
			description: 'Report how this process was started',
			input: {},
			annotations: { readOnlyHint: true },
			run: () => process.execArgv,
		}),
		defaulted: defineAction({
			description: 'Take a raw field with a default',
			input: { count: { type: 'number', default: 3 } as never, day: field.date({ optional: true }) },
			annotations: { readOnlyHint: true },
			run: (input) => input,
		}),
	},
});
`;

const repairsApp = {
	'.gitignore': gitignore,
	'data/a.md': 'base a\n',
	'epicenter.ts': repairsCode,
};

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const signals = join(f.root, 'signals');
	await mkdir(signals);
	const paused = async (name = 'paused') => {
		while (!existsSync(join(signals, name))) await Bun.sleep(10);
	};
	const go = () => writeFile(join(signals, 'go'), '1');
	const json = async (...args: string[]) => {
		const result = await f.run(...args, '--json');
		return { ...result, report: JSON.parse(result.stdout) };
	};
	return { ...f, signals, paused, go, json };
}

/** The notes app in the home, as its own repository. */
function notes(f: Awaited<ReturnType<typeof setup>>) {
	return f.folder(join(f.home, 'notes'), repairsApp);
}

function serve(f: Awaited<ReturnType<typeof setup>>, execArgv: string[] = []) {
	return new StdioClientTransport({
		command: process.execPath,
		args: [...execArgv, f.bin, 'serve', '--stdio'],
		cwd: f.root,
		env: f.env as Record<string, string>,
		stderr: 'pipe',
	});
}

test('F1 new puts the next step on stderr; a broken root is a usage error', async () => {
	const f = await setup();
	const made = await f.run('new', 'garden');
	expect(made.code).toBe(0);
	expect(made.stdout).toBe(`${join(f.home, 'garden')}\n`);
	expect(made.stderr).toBe(
		`Run: epicenter garden\nnot backed up\nRun: git -C ${join(f.home, 'garden')} remote add origin <url> and git -C ${join(f.home, 'garden/data')} remote add origin <url>, each a private repository, then epicenter sync garden\n`,
	);

	await rm(f.home, { recursive: true });
	await writeFile(f.home, 'not a folder');
	const listed = await f.json();
	expect(listed.code).toBe(2);
	expect(listed.report.error.name).toBe('Usage');
});

test('F6 the child finishes the run when its parent dies', async () => {
	const f = await setup();
	const folder = await notes(f);
	const parent = Bun.spawn(
		[process.execPath, f.bin, 'notes', 'orphan', '--signals', f.signals],
		{ cwd: f.root, env: f.env, stdout: 'pipe', stderr: 'pipe' },
	);
	await f.paused('parent');
	expect(Number(await readFile(join(f.signals, 'parent'), 'utf8'))).toBe(
		parent.pid,
	);
	parent.kill('SIGKILL');
	await parent.exited;
	await f.go();
	const deadline = Date.now() + 15_000;
	while (
		(await readFile(join(folder, 'data/a.md'), 'utf8')) !==
			'finished without a parent' &&
		Date.now() < deadline
	)
		await Bun.sleep(50);
	expect(await readFile(join(folder, 'data/a.md'), 'utf8')).toBe(
		'finished without a parent',
	);
});

test('F7 over MCP a broken app loses only its tools, and a call is decoded from the tool name', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), readingApp);
	await notes(f);
	await f.folder(join(f.home, 'broken'), {
		'.gitignore': gitignore,
		'epicenter.ts': `import 'epicenter-acceptance-not-installed';\nexport default {};\n`,
	});
	await f.app(
		'loud',
		`console.log('noise while importing');
export default defineApp({ description: 'The loud app', collections: {}, actions: { hello: defineAction({ description: 'Say hello', input: {}, run: () => 'hello' }) } });
`,
	);
	const client = new Client({ name: 'acceptance', version: '1' });
	try {
		await client.connect(serve(f, ['--no-install']));
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).toContain('reading_log');
		expect(names).toContain('loud_hello');
		expect(names).toContain('notes_two');
		expect(names.some((name) => name.startsWith('broken_'))).toBe(false);

		const flags = await client.callTool({ name: 'notes_flags', arguments: {} });
		expect(flags.structuredContent).toMatchObject({
			returned: expect.arrayContaining(['--no-install']),
		});
		const hello = await client.callTool({ name: 'loud_hello', arguments: {} });
		expect(hello.isError).toBeFalsy();
		expect(hello.structuredContent).toEqual({ returned: 'hello' });
		const unknown = await client.callTool({
			name: 'notes_nope',
			arguments: {},
		});
		expect(unknown.isError).toBe(true);
		expect(unknown.structuredContent).toMatchObject({
			error: { name: 'Usage' },
		});
		const broken = await client.callTool({ name: 'broken_x', arguments: {} });
		expect(broken.isError).toBe(true);
		expect(broken.structuredContent).toMatchObject({
			error: { name: 'AppProblems' },
		});
	} finally {
		await client.close();
	}
});

test('F9 one table owns the vocabulary; --json goes anywhere; defaulted fields are not required', async () => {
	const f = await setup();
	await notes(f);
	for (const word of ['install', 'open', 'types', 'setup', 'help']) {
		const result = await f.json(word);
		expect(result.code).toBe(2);
		expect(result.report.error.message).toContain(`Unknown app "${word}"`);
	}
	for (const word of ['new', 'update', 'sync', 'serve', 'init', 'build'])
		expect((await f.json('new', word)).code).toBe(2);
	expect((await f.json('new', 'link')).code).toBe(0);
	const help = (await f.run('--help')).stdout;
	expect(help).toContain('epicenter sync [<app> [-m <message>]]');
	expect(help).toContain(
		'Exit codes: 0 done, 1 threw or an app did not sync, 2 did not run.',
	);
	for (const gone of ['install', 'epicenter types', 'setup', 'epicenter help'])
		expect(help).not.toContain(gone);

	const leading = await f.run('--json', 'notes', 'two', 'Ada');
	expect(leading.code).toBe(0);
	expect(JSON.parse(leading.stdout)).toEqual({
		returned: 'Ada',
	});
	expect(JSON.parse((await f.run('--json', 'notes')).stdout).name).toBe(
		'notes',
	);

	const tool = JSON.parse(
		(await f.run('notes', 'defaulted', '--help', '--json')).stdout,
	);
	expect(tool.inputSchema.required ?? []).not.toContain('count');
	const ran = await f.json('notes', 'defaulted');
	expect(ran.report.returned).toEqual({ count: 3 });
	expect((await f.run('notes', 'defaulted', '--help')).stdout).toContain(
		'--count <number>  default 3.',
	);
});

test('F10 typing waits for its first consumer: no epicenter types, no generated file', async () => {
	const f = await setup();
	expect((await f.run('new', 'garden')).code).toBe(0);
	expect(await readFile(join(f.home, 'garden', '.gitignore'), 'utf8')).toBe(
		gitignore,
	);
	await f.app(
		'other',
		`export default defineApp({ description: 'Another app', collections: {}, actions: { hi: defineAction({ description: 'Hi', input: {}, run: () => 'hi' }) } });\n`,
	);
	const listed = await f.json('other');
	expect(listed.code).toBe(0);
	expect(listed.report).not.toHaveProperty('notes');
	expect(JSON.stringify((await f.json()).report)).not.toContain(
		'epicenter.d.json.ts',
	);
	expect((await f.json('other', 'hi')).report).toEqual({ returned: 'hi' });
	expect(existsSync(join(repo, 'packages/cli/src/types.ts'))).toBe(false);
});

test("F12 field.date() carries format: 'date', and the CLI reads the format", async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), readingApp);
	const tool = JSON.parse(
		(await f.run('reading', 'between', '--help', '--json')).stdout,
	);
	expect(tool.inputSchema.properties.from).toEqual({
		type: 'string',
		format: 'date',
	});
	expect((await f.run('reading', 'between', '-h')).stdout).toContain(
		'<from>, --from <date>  required.',
	);
	const bad = await f.json('reading', 'between', '2026-13-45', '2026-11-08');
	expect(bad.code).toBe(2);
	expect(bad.report.error.message).toContain('<from>');
});
