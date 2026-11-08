/**
 * Acceptance, stage 2: the commit rule (ADR-0850). Black-box runs of the real
 * `epicenter` against a temporary HOME. An action writes as it runs; whether
 * it returns or throws, `epicenter` commits exactly the bytes it wrote, and a
 * path someone else changed is left uncommitted and named.
 */

import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
	declarationOf,
	fixture,
	gitIn,
	gitignore,
} from './runner.test-support.ts';

setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** An app whose actions each exercise one part of the rule; signals pause an action at a known point. */
const notesApp = {
	'.gitignore': gitignore,
	'a.md': 'base a\n',
	'epicenter.json': declarationOf('notes'),
	'epicenter.ts': `import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';

const until = async (path: string) => {
	while (!(await Bun.file(path).exists())) await Bun.sleep(10);
};

export default defineApp(declaration, {
	actions: {
		two: {
			description: 'Write two files',
			input: { text: field.text() },
			positional: ['text'],
			run: async ({ text }, { folder }) => {
				await folder.write('a.md', text);
				await folder.write('b.md', text);
				return text;
			},
		},
		explode: {
			description: 'Write, then throw',
			input: { text: field.text({ optional: true }) },
			run: async ({ text }, { folder }) => {
				await folder.write('a.md', text ?? 'partial');
				throw new Error(text ?? 'line 4 is not a number');
			},
		},
		tagged: {
			description: 'Throw a tagged error',
			input: {},
			run: () => {
				throw Object.freeze({ name: 'QuotaExceeded', message: 'Out of quota', limit: 5 });
			},
		},
		paused: {
			description: 'Write, wait for a signal, write',
			input: { signals: field.text() },
			run: async ({ signals }, { folder }) => {
				await folder.write('a.md', 'action a');
				await Bun.write(signals + '/paused', '1');
				await until(signals + '/go');
				await folder.write('b.md', 'action b');
			},
		},
		late: {
			description: 'Wait for a signal, then write',
			input: { signals: field.text() },
			run: async ({ signals }, { folder }) => {
				await Bun.write(signals + '/paused', '1');
				await until(signals + '/go');
				await folder.write('a.md', 'action a');
			},
		},
		ignored: {
			description: 'Write a cache file and a note',
			input: {},
			run: async (_, { folder }) => {
				await folder.write('.cache/index.json', '{}');
				await folder.write('out.md', 'out');
			},
		},
		hang: {
			description: 'Write, then never finish',
			input: { signals: field.text() },
			run: async ({ signals }, { folder }) => {
				await folder.write('a.md', 'hung');
				await Bun.write(signals + '/paused', '1');
				await new Promise(() => {});
			},
		},
		chatty: {
			description: 'Log while running',
			input: {},
			run: async (_, { folder }) => {
				console.log('hello from log');
				console.info('hello from info');
				await folder.write('a.md', 'chatty');
				return 'answer';
			},
		},
		secret: {
			description: 'Take a token that never reaches history',
			input: { token: field.text({ writeOnly: true }), label: field.text() },
			run: async ({ label }, { folder }) => {
				await folder.write('a.md', label);
			},
		},
	},
});
`,
};

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const folder = await f.folder(join(f.home, 'notes'), notesApp);
	const signals = join(f.root, 'signals');
	await mkdir(signals);
	const head = () => gitIn(folder, 'rev-parse', 'HEAD');
	const message = (rev = 'HEAD') =>
		gitIn(folder, 'log', '-1', '--format=%B', rev);
	const changed = async (rev = 'HEAD') =>
		(
			await gitIn(
				folder,
				'diff-tree',
				'--no-commit-id',
				'--name-only',
				'-r',
				rev,
			)
		).split('\n');
	/** Wait until the action says it paused. */
	const paused = async () => {
		while (!existsSync(join(signals, 'paused'))) await Bun.sleep(10);
	};
	const go = () => writeFile(join(signals, 'go'), '1');
	return { ...f, folder, signals, head, message, changed, paused, go };
}

function mcp(f: Awaited<ReturnType<typeof setup>>) {
	return new StdioClientTransport({
		command: process.execPath,
		args: [f.bin, 'serve', '--stdio'],
		cwd: f.root,
		env: f.env as Record<string, string>,
		stderr: 'pipe',
	});
}

test('C1 an action that writes makes one commit named for it', async () => {
	const f = await setup();
	const before = await f.head();
	const human = await f.run('notes', 'two', 'Ada');
	expect(human.code).toBe(0);
	expect(human.stdout).toBe('Ada\n');
	expect(human.stderr).toMatch(/^committed [a-f0-9]{7} notes two\n$/);
	expect(await f.message()).toBe('notes two\n\n{"text":"Ada"}');
	expect(await f.changed()).toEqual(['a.md', 'b.md']);
	expect(await gitIn(f.folder, 'rev-list', '--count', `${before}..HEAD`)).toBe(
		'1',
	);

	const json = await f.run('notes', 'two', 'Grace', '--json');
	expect(json.code).toBe(0);
	expect(JSON.parse(json.stdout)).toEqual({
		result: 'Grace',
		commit: {
			sha: await f.head(),
			subject: 'notes two',
			paths: ['a.md', 'b.md'],
		},
		uncommitted: [],
	});
	expect(await gitIn(f.folder, 'status', '--porcelain')).toBe('');
});

test('C2 an action that writes and throws exits 3, and its writes are committed with the failure named', async () => {
	const f = await setup();
	const human = await f.run('notes', 'explode');
	expect(human.code).toBe(3);
	expect(human.stdout).toBe('');
	expect(human.stderr).toMatch(
		/^committed [a-f0-9]{7} notes explode \(failed: line 4 is not a number\)\nline 4 is not a number\n$/,
	);
	expect(await readFile(join(f.folder, 'a.md'), 'utf8')).toBe('partial');
	expect(await f.message()).toBe(
		'notes explode (failed: line 4 is not a number)\n\n{}\n\nline 4 is not a number',
	);

	const long = `${'a long first line that goes on '.repeat(4)}end\nand a second line`;
	const json = await f.run('notes', 'explode', '--text', long, '--json');
	expect(json.code).toBe(3);
	const subject = (await f.message()).split('\n')[0] ?? '';
	expect(subject.startsWith('notes explode (failed: a long first line')).toBe(
		true,
	);
	expect(subject.length).toBeLessThanOrEqual(
		'notes explode (failed: )'.length + 61,
	);
	expect(subject).not.toContain('second line');
	expect(await f.message()).toContain(long);
	expect(JSON.parse(json.stdout)).toEqual({
		error: {
			name: 'ActionThrew',
			message: long,
			commit: { sha: await f.head(), subject, paths: ['a.md'] },
			uncommitted: [],
		},
	});

	const tagged = await f.run('notes', 'tagged', '--json');
	expect(tagged.code).toBe(3);
	expect(JSON.parse(tagged.stdout)).toEqual({
		error: {
			name: 'ActionThrew',
			message: 'Out of quota',
			thrown: { name: 'QuotaExceeded', message: 'Out of quota', limit: 5 },
			commit: null,
			uncommitted: [],
		},
	});

	const client = new Client({ name: 'acceptance', version: '1' });
	try {
		await client.connect(mcp(f));
		const failed = await client.callTool({
			name: 'notes_tagged',
			arguments: {},
		});
		expect(failed.isError).toBe(true);
		expect(failed.structuredContent).toEqual(JSON.parse(tagged.stdout));
		const ok = await client.callTool({
			name: 'notes_two',
			arguments: { text: 'Mcp' },
		});
		expect(ok.isError).toBeFalsy();
		expect(ok.structuredContent).toEqual({
			result: 'Mcp',
			commit: {
				sha: await f.head(),
				subject: 'notes two',
				paths: ['a.md', 'b.md'],
			},
			uncommitted: [],
		});
	} finally {
		await client.close();
	}
});

test('C3 a write to a path with uncommitted edits is refused before anything is written', async () => {
	const f = await setup();
	await writeFile(join(f.folder, 'a.md'), 'my edit\n');
	const before = await f.head();
	const result = await f.run('notes', 'two', 'Ada', '--json');
	expect(result.code).toBe(3);
	expect(JSON.parse(result.stdout).error).toMatchObject({
		name: 'PathUncommitted',
		path: 'a.md',
		commit: null,
	});
	expect(await readFile(join(f.folder, 'a.md'), 'utf8')).toBe('my edit\n');
	expect(existsSync(join(f.folder, 'b.md'))).toBe(false);
	expect(await f.head()).toBe(before);
	const human = await f.run('notes', 'two', 'Ada');
	expect(human.stderr).toContain('a.md');
	expect(human.stderr).toContain('Run: ');
});

test('C4 a path someone changes during the run stays uncommitted and named; the rest commits', async () => {
	const f = await setup();
	const running = f.run('notes', 'paused', '--signals', f.signals, '--json');
	await f.paused();
	await writeFile(join(f.folder, 'a.md'), 'editor a\n');
	await f.go();
	const result = await running;
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({
		commit: { subject: 'notes paused', paths: ['a.md', 'b.md'] },
		uncommitted: ['a.md'],
	});
	expect(await gitIn(f.folder, 'show', 'HEAD:a.md')).toBe('action a');
	expect(await gitIn(f.folder, 'show', 'HEAD:b.md')).toBe('action b');
	expect(await readFile(join(f.folder, 'a.md'), 'utf8')).toBe('editor a\n');
	expect(await gitIn(f.folder, 'status', '--porcelain')).toBe('M a.md');
	const human = await f.run('notes', 'two', 'x');
	expect(human.stderr).toContain('a.md');

	await gitIn(f.folder, 'checkout', '--', 'a.md');
	await rm(join(f.signals, 'paused'));
	await rm(join(f.signals, 'go'));
	const before = await f.head();
	const late = f.run('notes', 'late', '--signals', f.signals, '--json');
	await f.paused();
	await writeFile(join(f.folder, 'a.md'), 'saved first\n');
	await f.go();
	const refused = await late;
	expect(refused.code).toBe(3);
	expect(JSON.parse(refused.stdout).error).toMatchObject({
		name: 'PathUncommitted',
		path: 'a.md',
	});
	expect(await readFile(join(f.folder, 'a.md'), 'utf8')).toBe('saved first\n');
	expect(await f.head()).toBe(before);
});

test('C5 gitignored paths are written and never committed', async () => {
	const f = await setup();
	const result = await f.run('notes', 'ignored', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).commit.paths).toEqual(['out.md']);
	expect(await readFile(join(f.folder, '.cache/index.json'), 'utf8')).toBe(
		'{}',
	);
	expect(await gitIn(f.folder, 'status', '--porcelain')).toBe('');
});

test('C6 a run killed with SIGKILL leaves its writes uncommitted, and the next run that writes them is refused', async () => {
	const f = await setup();
	const before = await f.head();
	const child = Bun.spawn(
		[process.execPath, f.bin, 'notes', 'hang', '--signals', f.signals],
		{ cwd: f.root, env: f.env, stdout: 'pipe', stderr: 'pipe' },
	);
	await f.paused();
	child.kill('SIGKILL');
	await child.exited;
	expect(await f.head()).toBe(before);
	expect(await readFile(join(f.folder, 'a.md'), 'utf8')).toBe('hung');
	expect(await gitIn(f.folder, 'status', '--porcelain')).toBe('M a.md');
	const next = await f.run('notes', 'two', 'Ada', '--json');
	expect(next.code).toBe(3);
	expect(JSON.parse(next.stdout).error).toMatchObject({
		name: 'PathUncommitted',
		path: 'a.md',
	});
	expect(existsSync(join(f.folder, 'b.md'))).toBe(false);
});

test('C7 runs racing an agent that commits and edits lose nothing and misfile nothing', async () => {
	const script = resolve(import.meta.dir, '../scripts/race.ts');
	const child = Bun.spawn(
		[process.execPath, script, '--runs', '24', '--concurrency', '3'],
		{
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({
		code: 0,
		stderr: '',
	});
	expect(JSON.parse(stdout)).toMatchObject({ runs: 24, lost: 0, misfiled: 0 });
});

test('C8 stdout belongs to epicenter: an action that logs does not corrupt --json or serve --stdio', async () => {
	const f = await setup();
	const json = await f.run('notes', 'chatty', '--json');
	expect(json.code).toBe(0);
	expect(JSON.parse(json.stdout)).toMatchObject({ result: 'answer' });
	expect(json.stderr).toContain('hello from log');
	expect(json.stderr).toContain('hello from info');
	const client = new Client({ name: 'acceptance', version: '1' });
	try {
		await client.connect(mcp(f));
		const called = await client.callTool({
			name: 'notes_chatty',
			arguments: {},
		});
		expect(called.isError).toBeFalsy();
		expect(called.structuredContent).toMatchObject({ result: 'answer' });
		expect((await client.listTools()).tools.length).toBeGreaterThan(0);
	} finally {
		await client.close();
	}
});

test('C9 an input marked writeOnly stays out of the commit body', async () => {
	const f = await setup();
	const result = await f.run(
		'notes',
		'secret',
		'--token',
		'hunter2',
		'--label',
		'x',
	);
	expect(result.code).toBe(0);
	expect(await f.message()).toBe('notes secret\n\n{"label":"x"}');
	expect(await gitIn(f.folder, 'log', '-p', '-1')).not.toContain('hunter2');
});
