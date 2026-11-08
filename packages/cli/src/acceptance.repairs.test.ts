/**
 * Acceptance, stage 2c: the final review's repairs, F1 to F14. Black-box runs
 * of the real `epicenter` against a temporary HOME, except where an item is a
 * statement about the records or the source, which is read from the tree.
 *
 * A run's answer is one report:
 * `{ action: { returned } | { threw }, refused, commit, paths, push }`, and
 * stderr is a rendering of it.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	chmod,
	mkdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { renderReport } from './output.ts';
import {
	declarationOf,
	fixture,
	gitIn,
	gitignore,
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
const repairsCode = `import declaration from './epicenter.json';
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
		swallow: {
			description: 'Write b.md, try a.md, and keep going when refused',
			input: {},
			run: async (_, { folder }) => {
				await folder.write('b.md', 'action b');
				try {
					await folder.write('a.md', 'action a');
				} catch {}
				return 'carried on';
			},
		},
		wrap: {
			description: 'Write b.md, try a.md, and throw something else when refused',
			input: {},
			run: async (_, { folder }) => {
				await folder.write('b.md', 'action b');
				try {
					await folder.write('a.md', 'action a');
				} catch {
					throw new Error('could not save the page');
				}
			},
		},
		late: {
			description: 'Wait for a signal, then write a.md',
			input: { signals: field.text() },
			run: async ({ signals }, { folder }) => {
				await Bun.write(signals + '/paused', '1');
				await until(signals + '/go');
				await folder.write('a.md', 'action a');
			},
		},
		paused: {
			description: 'Write a.md, wait for a signal, write b.md',
			input: { signals: field.text() },
			run: async ({ signals }, { folder }) => {
				await folder.write('a.md', 'action a');
				await Bun.write(signals + '/paused', '1');
				await until(signals + '/go');
				await folder.write('b.md', 'action b');
			},
		},
		script: {
			description: 'Rewrite the executable run.sh',
			input: {},
			run: async (_, { folder }) => {
				await folder.write('run.sh', '#!/bin/sh\\necho new\\n');
			},
		},
		glob: {
			description: 'Write a path with glob characters',
			input: {},
			run: async (_, { folder }) => {
				await folder.write('[d].md', 'bracketed');
			},
		},
		noisy: {
			description: 'Write to the console every way Bun can',
			input: {},
			run: async (_, { folder }) => {
				console.debug('debug line');
				console.table([{ a: 1 }]);
				console.dir({ dir: true });
				console.log('log line');
				process.stdout.write('raw stdout\\n');
				await folder.write('a.md', 'noisy');
				return 'answer';
			},
		},
		pid: {
			description: 'Write a.md and leave the pid of the process running it',
			input: { signals: field.text() },
			run: async ({ signals }, { folder }) => {
				await folder.write('a.md', 'committed then killed');
				await Bun.write(signals + '/pid', String(process.pid));
			},
		},
		orphan: {
			description: 'Leave the parent pid, wait for a signal, then write a.md',
			input: { signals: field.text() },
			run: async ({ signals }, { folder }) => {
				await Bun.write(signals + '/parent', String(process.ppid));
				await until(signals + '/go');
				await folder.write('a.md', 'finished without a parent');
			},
		},
		flags: {
			description: 'Report how this process was started',
			input: {},
			annotations: { readOnlyHint: true },
			run: () => process.execArgv,
		},
		defaulted: {
			description: 'Take a raw field with a default',
			input: { count: { type: 'number', default: 3 } as never, day: field.date({ optional: true }) },
			annotations: { readOnlyHint: true },
			run: (input) => input,
		},
	},
});
`;

const repairsApp = {
	'.gitignore': gitignore,
	'a.md': 'base a\n',
	'run.sh': '#!/bin/sh\necho old\n',
	'epicenter.json': declarationOf('notes'),
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
async function notes(f: Awaited<ReturnType<typeof setup>>) {
	const folder = await f.folder(join(f.home, 'notes'), repairsApp);
	await chmod(join(folder, 'run.sh'), 0o755);
	await gitIn(folder, 'add', 'run.sh');
	await gitIn(folder, 'commit', '-q', '-m', 'executable');
	return folder;
}

/** The notes app cloned from a bare `origin`, so its branch tracks the same name there. */
async function notesWithOrigin(f: Awaited<ReturnType<typeof setup>>) {
	const seed = await f.folder(join(f.root, 'seed'), repairsApp);
	const bare = join(f.root, 'origin.git');
	await gitIn(f.root, 'clone', '-q', '--bare', seed, bare);
	const folder = join(f.home, 'notes');
	await gitIn(f.root, 'clone', '-q', bare, folder);
	const branch = await gitIn(folder, 'rev-parse', '--abbrev-ref', 'HEAD');
	return { folder, bare, branch };
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

const head = (folder: string) => gitIn(folder, 'rev-parse', 'HEAD');

test('F1 a run returns one report, and its exit code is derived from it', async () => {
	const f = await setup();
	const folder = await notes(f);
	const ran = await f.json('notes', 'two', 'Ada');
	expect(ran.code).toBe(0);
	expect(ran.report).toEqual({
		action: { returned: 'Ada' },
		refused: [],
		commit: {
			sha: await head(folder),
			subject: 'notes two',
			paths: ['a.md', 'b.md'],
		},
		paths: [
			{ path: 'a.md', state: 'committed' },
			{ path: 'b.md', state: 'committed' },
		],
		push: null,
	});

	await writeFile(join(folder, 'a.md'), 'my edit\n');
	const refused = await f.json('notes', 'two', 'Grace');
	expect(refused.code).toBe(3);
	expect(refused.report).toMatchObject({
		action: { threw: { message: expect.stringContaining('a.md') } },
		refused: [
			{
				path: 'a.md',
				reason: 'uncommitted',
				next: `git -C ${folder} status -- a.md`,
			},
		],
		commit: null,
		paths: [],
	});

	// Did not run: one error, with exit 2.
	const unknown = await f.json('notes', 'nope');
	expect(unknown.code).toBe(2);
	expect(unknown.report.error).toMatchObject({ name: 'Usage' });
});

test('F1 every stderr line is derivable from --json, and push state is in --json and MCP', async () => {
	const f = await setup();
	const { folder, bare, branch } = await notesWithOrigin(f);
	f.env.GIT_AUTHOR_DATE = '2026-11-09T12:00:00Z';
	f.env.GIT_COMMITTER_DATE = '2026-11-09T12:00:00Z';
	const start = await head(folder);
	/** Put the folder, origin, and what the folder knows of origin back at `start`, with a.md edited. */
	const reset = async () => {
		await gitIn(folder, 'reset', '-q', '--hard', start);
		await gitIn(bare, 'update-ref', `refs/heads/${branch}`, start);
		await gitIn(folder, 'update-ref', `refs/remotes/origin/${branch}`, start);
		await writeFile(join(folder, 'a.md'), 'my edit\n');
	};
	for (const action of ['swallow', 'wrap', 'two']) {
		await reset();
		const args = action === 'two' ? ['two', 'Ada'] : [action];
		if (action === 'two') await gitIn(folder, 'checkout', '--', 'a.md');
		const json = await f.json('notes', ...args);
		await reset();
		if (action === 'two') await gitIn(folder, 'checkout', '--', 'a.md');
		const human = await f.run('notes', ...args);
		expect(human.code).toBe(json.code);
		expect(renderReport(json.report)).toEqual({
			stdout: human.stdout,
			stderr: human.stderr,
		});
		expect(json.report.push).toEqual({ pushed: true, ahead: 0, behind: 0 });
		expect(human.stderr).toContain('pushed to origin');
	}

	const client = new Client({ name: 'acceptance', version: '1' });
	try {
		await client.connect(serve(f));
		const called = await client.callTool({
			name: 'notes_two',
			arguments: { text: 'Mcp' },
		});
		expect(called.isError).toBeFalsy();
		expect(called.structuredContent).toMatchObject({
			action: { returned: 'Mcp' },
			push: { pushed: true, ahead: 0, behind: 0 },
		});
	} finally {
		await client.close();
	}
});

test('F1 new and add put the next step on stderr; an unexpected throw before a run is Internal, not Usage', async () => {
	const f = await setup();
	const made = await f.run('new', 'garden');
	expect(made.code).toBe(0);
	expect(made.stdout).toBe(`${join(f.home, 'garden')}\n`);
	expect(made.stderr).toBe('Run: epicenter garden\n');

	await rm(f.home, { recursive: true });
	await writeFile(f.home, 'not a folder');
	const listed = await f.json();
	expect(listed.code).toBe(2);
	expect(listed.report.error.name).toBe('Internal');
});

test('F2 the run records a refusal, so an action that swallows or wraps one still exits 3 with the path', async () => {
	const f = await setup();
	const folder = await notes(f);
	await writeFile(join(folder, 'a.md'), 'my edit\n');

	const swallowed = await f.json('notes', 'swallow');
	expect(swallowed.code).toBe(3);
	expect(swallowed.report).toMatchObject({
		action: { returned: 'carried on' },
		refused: [{ path: 'a.md', reason: 'uncommitted' }],
		commit: { paths: ['b.md'] },
		paths: [{ path: 'b.md', state: 'committed' }],
	});
	expect(swallowed.report.commit.subject).toStartWith(
		'notes swallow (failed: ',
	);
	expect(await readFile(join(folder, 'a.md'), 'utf8')).toBe('my edit\n');

	await gitIn(folder, 'reset', '-q', '--hard', 'HEAD~1');
	await writeFile(join(folder, 'a.md'), 'my edit\n');
	const wrapped = await f.json('notes', 'wrap');
	expect(wrapped.code).toBe(3);
	expect(wrapped.report).toMatchObject({
		action: { threw: { message: 'could not save the page' } },
		refused: [{ path: 'a.md', reason: 'uncommitted' }],
		commit: { paths: ['b.md'] },
	});
	const human = await f.run('notes', 'wrap');
	expect(human.stderr).toContain('a.md has changes you have not committed');
	expect(human.stderr).toContain(`Run: git -C ${folder} status -- a.md`);
});

test('F3 a commit made during the run before the action wrote a path is no contest', async () => {
	const f = await setup();
	const folder = await notes(f);
	const running = f.json('notes', 'late', '--signals', f.signals);
	await f.paused();
	await writeFile(join(folder, 'a.md'), 'person a\n');
	await gitIn(folder, 'commit', '-q', '-am', 'person');
	await f.go();
	const { code, report } = await running;
	expect(code).toBe(0);
	expect(report.paths).toEqual([{ path: 'a.md', state: 'committed' }]);
	expect(await gitIn(folder, 'show', 'HEAD:a.md')).toBe('action a');
	expect(await gitIn(folder, 'log', '-1', '--format=%s', 'HEAD~1')).toBe(
		'person',
	);
});

test("F3 a commit that already holds the action's bytes is already in history; one with other bytes is contested", async () => {
	const f = await setup();
	const folder = await notes(f);
	let running = f.json('notes', 'paused', '--signals', f.signals);
	await f.paused();
	await gitIn(folder, 'commit', '-q', '-m', 'swept in', '--', 'a.md');
	await f.go();
	let { code, report } = await running;
	expect(code).toBe(0);
	expect(report.paths).toEqual([
		{ path: 'a.md', state: 'already-in-history' },
		{ path: 'b.md', state: 'committed' },
	]);
	expect(report.commit.paths).toEqual(['b.md']);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');

	await rm(join(f.signals, 'paused'));
	await rm(join(f.signals, 'go'));
	running = f.json('notes', 'paused', '--signals', f.signals);
	await f.paused();
	await writeFile(join(folder, 'a.md'), 'person a\n');
	await gitIn(folder, 'commit', '-q', '-m', 'person', '--', 'a.md');
	await f.go();
	({ code, report } = await running);
	expect(code).toBe(0);
	expect(report.paths).toEqual([
		{ path: 'a.md', state: 'contested' },
		{ path: 'b.md', state: 'committed' },
	]);
	expect(await gitIn(folder, 'show', 'HEAD:a.md')).toBe('person a');
	expect((await f.run('notes', 'two', 'x')).code).toBe(0);
});

test('F3 a symlink target is refused, the executable bit is kept, and a first commit made during a run on an unborn branch is its parent', async () => {
	const f = await setup();
	const folder = await notes(f);
	const outside = join(f.root, 'outside.md');
	await writeFile(outside, 'outside\n');
	await rm(join(folder, 'a.md'));
	await symlink(outside, join(folder, 'a.md'));
	await gitIn(folder, 'add', 'a.md');
	await gitIn(folder, 'commit', '-q', '-m', 'link');
	const linked = await f.json('notes', 'two', 'Ada');
	expect(linked.code).toBe(3);
	expect(linked.report.refused).toMatchObject([
		{ path: 'a.md', reason: 'symlink' },
	]);
	expect(await readFile(outside, 'utf8')).toBe('outside\n');
	expect(await gitIn(folder, 'ls-tree', 'HEAD', 'a.md')).toStartWith('120000 ');

	const script = await f.json('notes', 'script');
	expect(script.code).toBe(0);
	expect(await gitIn(folder, 'ls-tree', 'HEAD', 'run.sh')).toStartWith(
		'100755 ',
	);
	expect((await stat(join(folder, 'run.sh'))).mode & 0o111).not.toBe(0);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');

	const unborn = join(f.home, 'fresh');
	await f.folder(
		unborn,
		{ ...repairsApp, 'epicenter.json': declarationOf('fresh') },
		{ git: false },
	);
	await gitIn(unborn, 'init', '-q');
	await rm(join(unborn, 'a.md'));
	const running = f.json('fresh', 'paused', '--signals', f.signals);
	await f.paused();
	await gitIn(unborn, 'add', 'epicenter.json', 'epicenter.ts', '.gitignore');
	await gitIn(
		unborn,
		'-c',
		'user.name=P',
		'-c',
		'user.email=p@example.com',
		'commit',
		'-q',
		'-m',
		'first',
	);
	const first = await head(unborn);
	await f.go();
	const { code, report } = await running;
	expect(code).toBe(0);
	expect(report.paths).toEqual([
		{ path: 'a.md', state: 'committed' },
		{ path: 'b.md', state: 'committed' },
	]);
	expect(await gitIn(unborn, 'rev-parse', 'HEAD~1')).toBe(first);
	expect(await gitIn(unborn, 'show', 'HEAD:epicenter.json')).toContain('fresh');
});

test('F4 a path with glob characters is a path, not a pattern', async () => {
	const f = await setup();
	const folder = await notes(f);
	await writeFile(
		join(folder, 'd.md'),
		'untracked, and matched by [d].md as a glob\n',
	);
	const { code, report } = await f.json('notes', 'glob');
	expect(code).toBe(0);
	expect(report.commit.paths).toEqual(['[d].md']);
	expect(await gitIn(folder, 'show', 'HEAD:[d].md')).toBe('bracketed');
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('?? d.md');
});

test('F5 a worktree branch whose upstream is origin/main does not push there', async () => {
	const f = await setup();
	const { folder, bare, branch } = await notesWithOrigin(f);
	const before = await gitIn(bare, 'rev-parse', branch);
	const worktree = join(f.root, 'worktree');
	await gitIn(
		folder,
		'worktree',
		'add',
		'-q',
		'--track',
		'-b',
		'experiment',
		worktree,
		`origin/${branch}`,
	);
	expect(await gitIn(worktree, 'rev-parse', '--abbrev-ref', '@{u}')).toBe(
		`origin/${branch}`,
	);
	const { code, report } = await f.json(worktree, 'two', 'draft');
	expect(code).toBe(0);
	expect(report.commit).not.toBeNull();
	expect(report.push).toBeNull();
	expect(await gitIn(bare, 'rev-parse', branch)).toBe(before);
	expect(await gitIn(bare, 'branch', '--list', 'experiment')).toBe('');
});

test("F6 an action's console output, every kind, never reaches the answer of --json or serve --stdio", async () => {
	const f = await setup();
	await notes(f);
	const { code, report, stderr } = await f.json('notes', 'noisy');
	expect(code).toBe(0);
	expect(report.action).toEqual({ returned: 'answer' });
	for (const line of ['debug line', 'log line', 'raw stdout', 'dir'])
		expect(stderr).toContain(line);

	const client = new Client({ name: 'acceptance', version: '1' });
	try {
		await client.connect(serve(f));
		const called = await client.callTool({
			name: 'notes_noisy',
			arguments: {},
		});
		expect(called.isError).toBeFalsy();
		expect(called.structuredContent).toMatchObject({
			action: { returned: 'answer' },
		});
	} finally {
		await client.close();
	}
});

test('F6 the child killed after its commit reports exit 3 with the heads; the child finishes when its parent dies', async () => {
	const f = await setup();
	const folder = await notes(f);
	const before = await head(folder);
	const hook = join(folder, '.git', 'hooks', 'reference-transaction');
	await writeFile(
		hook,
		`#!/bin/sh\n[ "$1" = committed ] || exit 0\ntouch '${f.signals}/committed'\nwhile [ ! -e '${f.signals}/release' ]; do sleep 0.05; done\n`,
	);
	await chmod(hook, 0o755);
	const running = f.json('notes', 'pid', '--signals', f.signals);
	await f.paused('committed');
	await f.paused('pid');
	process.kill(
		Number(await readFile(join(f.signals, 'pid'), 'utf8')),
		'SIGKILL',
	);
	const { code, report } = await running;
	await writeFile(join(f.signals, 'release'), '1');
	expect(code).toBe(3);
	const after = await head(folder);
	expect(after).not.toBe(before);
	expect(report).toEqual({
		unknown: {
			message: expect.any(String),
			head: { before, after },
		},
	});
	await rm(hook);
	await rm(join(folder, '.git', 'index.lock'), { force: true });

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
		(await gitIn(folder, 'log', '-1', '--format=%s')) !== 'notes orphan' &&
		Date.now() < deadline
	)
		await Bun.sleep(50);
	expect(await gitIn(folder, 'show', 'HEAD:a.md')).toBe(
		'finished without a parent',
	);
});

test('F7 over MCP a broken app loses only its tools, and a call is decoded from the tool name', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), readingApp);
	await notes(f);
	await f.folder(join(f.home, 'broken'), {
		'.gitignore': gitignore,
		'epicenter.json': declarationOf('broken'),
		'epicenter.ts': `import 'epicenter-acceptance-not-installed';\nexport default {};\n`,
	});
	await f.folder(join(f.home, 'loud'), {
		'.gitignore': gitignore,
		'epicenter.json': declarationOf('loud'),
		'epicenter.ts': `import declaration from './epicenter.json';
import { defineApp } from '@epicenter/app';
console.log('noise while importing');
export default defineApp(declaration, { actions: { hello: { description: 'Say hello', input: {}, run: () => 'hello' } } });
`,
	});
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
			action: { returned: expect.arrayContaining(['--no-install']) },
		});
		const hello = await client.callTool({ name: 'loud_hello', arguments: {} });
		expect(hello.isError).toBeFalsy();
		expect(hello.structuredContent).toMatchObject({
			action: { returned: 'hello' },
		});
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

test('F8 new, add --init, and add <url> adopt a folder the same way: template files and LFS before the first commit', async () => {
	const f = await setup();
	const lfs = Bun.which('git-lfs') !== null;
	const loose = await f.folder(
		join(f.root, 'Code', 'photos'),
		{
			'epicenter.json': declarationOf('photos'),
			'node_modules/pkg/index.js': 'module.exports = 1;\n',
		},
		{ git: false },
	);
	await writeFile(
		join(loose, 'cover.png'),
		new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
	);
	const added = await f.run('add', loose, '--init');
	expect(added.code).toBe(0);
	expect((await gitIn(loose, 'ls-files')).split('\n').sort()).toEqual([
		'.gitattributes',
		'.gitignore',
		'cover.png',
		'epicenter.json',
	]);
	expect(await readFile(join(loose, '.gitignore'), 'utf8')).toBe(gitignore);
	if (lfs) {
		expect(await gitIn(loose, 'show', 'HEAD:cover.png')).toStartWith(
			'version https://git-lfs.github.com/spec/v1',
		);
		expect(
			await gitIn(loose, 'config', '--local', '--get', 'filter.lfs.process'),
		).not.toBe('');
	}

	expect((await f.run('new', 'garden')).code).toBe(0);
	const garden = join(f.home, 'garden');
	if (lfs)
		expect(
			await gitIn(garden, 'config', '--local', '--get', 'filter.lfs.process'),
		).not.toBe('');

	const source = await f.folder(join(f.root, 'shared', 'recipes'), {
		'epicenter.json': declarationOf('recipes'),
		'soup.md': 'soup\n',
	});
	expect((await f.run('add', `file://${source}`)).code).toBe(0);
	const recipes = join(f.home, 'recipes');
	expect(await readFile(join(recipes, '.gitignore'), 'utf8')).toBe(gitignore);
	expect(await gitIn(recipes, 'status', '--porcelain')).toBe('');
	if (lfs)
		expect(
			await gitIn(recipes, 'config', '--local', '--get', 'filter.lfs.process'),
		).not.toBe('');
});

test('F9 one table owns the vocabulary; --json goes anywhere; defaulted fields are not required', async () => {
	const f = await setup();
	await notes(f);
	for (const word of ['update', 'open', 'types']) {
		const result = await f.json(word);
		expect(result.code).toBe(2);
		expect(result.report.error.message).toContain(`Unknown app "${word}"`);
	}
	const setupCommand = await f.json('setup');
	expect(setupCommand.code).toBe(2);
	expect(setupCommand.report.error.message).toContain('not built yet');
	expect((await f.json('new', 'setup')).code).toBe(2);
	const help = (await f.run('--help')).stdout;
	expect(help).toContain('epicenter setup');
	expect(help).not.toContain('update');
	expect(help).not.toContain('epicenter types');

	const leading = await f.run('--json', 'notes', 'two', 'Ada');
	expect(leading.code).toBe(0);
	expect(JSON.parse(leading.stdout).action).toEqual({ returned: 'Ada' });
	expect(JSON.parse((await f.run('--json', 'notes')).stdout).name).toBe(
		'notes',
	);

	const tool = JSON.parse(
		(await f.run('notes', 'defaulted', '--help', '--json')).stdout,
	);
	expect(tool.inputSchema.required ?? []).not.toContain('count');
	const ran = await f.json('notes', 'defaulted');
	expect(ran.report.action.returned).toEqual({ count: 3 });
	expect((await f.run('help', 'notes', 'defaulted')).stdout).toContain(
		'--count: number, default 3',
	);
});

test('F10 typing waits for its first consumer: no epicenter types, no generated file, no declaration check', async () => {
	const f = await setup();
	expect((await f.run('new', 'garden')).code).toBe(0);
	expect(await readFile(join(f.home, 'garden', '.gitignore'), 'utf8')).toBe(
		'node_modules/\n.cache/\n',
	);
	await f.folder(join(f.home, 'other'), {
		'.gitignore': gitignore,
		'epicenter.json': declarationOf('other'),
		'epicenter.ts': `import { defineApp } from '@epicenter/app';
export default defineApp({ name: 'not-this', description: 'Another declaration' }, { actions: { hi: { description: 'Hi', input: {}, run: () => 'hi' } } });
`,
	});
	const listed = await f.json('other');
	expect(listed.code).toBe(0);
	expect(listed.report).not.toHaveProperty('notes');
	expect(JSON.stringify((await f.json()).report)).not.toContain(
		'epicenter.d.json.ts',
	);
	expect((await f.json('other', 'hi')).report.action).toEqual({
		returned: 'hi',
	});
	expect(existsSync(join(repo, 'packages/cli/src/types.ts'))).toBe(false);
});

test('F11 the deletions: exit code 1, the lock queue, the test-secrets help line', async () => {
	const f = await setup();
	const help = (await f.run('--help')).stdout;
	expect(help).toContain('Exit codes: 0 ran, 2 did not run, 3 ran and failed');
	expect(help).not.toContain('finding');
	expect(help).not.toContain('EPICENTER_TEST_SECRETS');
	const lock = await readFile(
		join(repo, 'packages/cli/src/file-lock.ts'),
		'utf8',
	);
	for (const gone of ['turns', 'waitMs', 'held'])
		expect(lock).not.toContain(gone);
	const context = await readFile(
		join(repo, 'packages/app/src/context.ts'),
		'utf8',
	);
	expect(context).not.toContain('secrets?:');
	const disk = await readFile(join(repo, 'packages/cli/src/disk.ts'), 'utf8');
	expect(disk).not.toContain('log?:');
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
	expect((await f.run('help', 'reading', 'between')).stdout).toContain(
		'--from (<from>): date, required',
	);
	const bad = await f.json('reading', 'between', '2026-13-45', '2026-11-08');
	expect(bad.code).toBe(2);
	expect(bad.report.error.message).toContain('<from>');
});

test('F13 the records and READMEs say what the code does', async () => {
	const read = (path: string) => readFile(join(repo, path), 'utf8');
	for (const readme of ['packages/cli/README.md', 'packages/app/README.md']) {
		const text = await read(readme);
		expect(text).not.toContain('epicenter types');
		expect(text).not.toContain('epicenter.d.json.ts');
		expect(text).not.toMatch(/\b1 (a )?finding|exit(s)? 1\b/);
	}
	const adr = async (number: string) => {
		const glob = new Bun.Glob(`${number}-*.md`);
		const [name] = [...glob.scanSync(join(repo, 'docs/adr'))];
		return read(`docs/adr/${name}`);
	};
	expect(await adr('0850')).toContain('{ base, mode, object }');
	expect(await adr('0850')).toContain('GIT_LITERAL_PATHSPECS');
	expect(await adr('0851')).toContain('same name');
	expect(await adr('0852')).toContain('clones');
	expect(await adr('0857')).toContain('K1');
});

test("F14 file-lock.ts's header no longer mentions undo", async () => {
	const lock = await readFile(
		join(repo, 'packages/cli/src/file-lock.ts'),
		'utf8',
	);
	expect(lock).not.toContain('undo');
});
