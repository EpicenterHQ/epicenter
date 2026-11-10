/**
 * Acceptance, stage 2: snapshots (ADR-0850). Black-box runs of the real
 * `epicenter` against a temporary HOME. A run never commits; after a write
 * run, the command line takes a snapshot of everything pending in the app's
 * folder and nothing outside it, named for the call, with what no call wrote
 * listed as changed outside epicenter. A read-only action cannot write
 * through `folder` or `secrets`. The answer is `{ returned }`, `{ threw }`,
 * or `{ error }`, exit 0, 1, or 2, whatever became of the snapshot.
 */

import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
	mkdir,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, gitIn, gitignore, header } from './runner.test-support.ts';

setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

const notesCode = `${header}
export default defineApp({
	description: 'The notes app',
	collections: {},
	actions: {
		write: defineAction({
			description: 'Write a page, and note it in the cache',
			input: { page: field.text() },
			positional: ['page'],
			run: async ({ page }) => {
				await folder.write(page + '.md', page);
				await folder.write('.cache/seen.txt', page);
				return page;
			},
		}),
		same: defineAction({
			description: 'Write a page as it already is',
			input: {},
			run: async () => {
				await folder.write('a.md', 'base a\\n');
			},
		}),
		picture: defineAction({
			description: 'Write a binary',
			input: {},
			run: async () => {
				await folder.writeBytes('cover.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
			},
		}),
		half: defineAction({
			description: 'Write a page, then throw',
			input: { page: field.text() },
			positional: ['page'],
			run: async ({ page }) => {
				await folder.write(page + '.md', page);
				throw new Error('stopped halfway');
			},
		}),
		peek: defineAction({
			description: 'Say it only reads, then write',
			input: {},
			annotations: { readOnlyHint: true },
			run: async () => {
				await folder.write('peek.md', 'peeked');
			},
		}),
		sneak: defineAction({
			description: 'Say it only reads, then keep a secret',
			input: {},
			annotations: { readOnlyHint: true },
			run: () => secrets.set('token', 'kept'),
		}),
		tagged: defineAction({
			description: 'Throw a tagged error',
			input: {},
			run: () => {
				throw Object.freeze({ name: 'NotFound', message: 'no such page', page: 'x' });
			},
		}),
		exit: defineAction({
			description: 'End the process without an answer',
			input: {},
			run: () => process.exit(7),
		}),
		chatty: defineAction({
			description: 'Log to the console every way and return',
			input: {},
			run: () => {
				console.log('hello from log');
				console.info('hello from info');
				console.debug('hello from debug');
				console.table([{ a: 1 }]);
				process.stdout.write('raw stdout\\n');
				return 'answer';
			},
		}),
	},
});
`;

const notesApp = {
	'.gitignore': gitignore,
	'a.md': 'base a\n',
	'epicenter.ts': notesCode,
};

async function setup({ git = true }: { git?: boolean } = {}) {
	const f = await fixture();
	roots.push(f.root);
	const folder = await f.folder(join(f.home, 'notes'), notesApp, { git });
	const json = async (...args: string[]) => {
		const result = await f.run(...args, '--json');
		return { ...result, answer: JSON.parse(result.stdout) };
	};
	return { ...f, dir: folder, json };
}

const status = (folder: string) =>
	gitIn(folder, 'status', '--porcelain', '--untracked-files=all');
const subjects = (folder: string) => gitIn(folder, 'log', '--format=%s');

test('C1 a write run commits nothing itself, and the command line snapshots it as one commit named for the call', async () => {
	const f = await setup();
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(ran.answer).toEqual({ returned: 'monday' });
	expect(ran.stderr).toBe('');
	expect(await subjects(f.dir)).toBe('notes: write monday\ninitial');
	expect(await gitIn(f.dir, 'log', '-1', '--format=%B')).toBe(
		'notes: write monday',
	);
	expect(await status(f.dir)).toBe('');

	const loose = await setup({ git: false });
	const plain = await loose.json('notes', 'write', 'tuesday');
	expect(plain).toMatchObject({ code: 0, stderr: '' });
	expect(plain.answer).toEqual({ returned: 'tuesday' });
	expect(await readFile(join(loose.dir, 'tuesday.md'), 'utf8')).toBe('tuesday');
});

test('C2 a snapshot takes everything pending in the folder, staged or not, never ignored files, and names what no call wrote', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'a.md'), 'edited by hand\n');
	await writeFile(join(f.dir, 'staged.md'), 'staged\n');
	await gitIn(f.dir, 'add', 'staged.md');
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(await gitIn(f.dir, 'log', '-1', '--format=%B')).toBe(
		'notes: write monday\n\nChanged outside epicenter: a.md, staged.md',
	);
	expect(
		(await gitIn(f.dir, 'show', '--name-only', '--format=', 'HEAD')).split(
			'\n',
		),
	).toEqual(['a.md', 'monday.md', 'staged.md']);
	expect(await status(f.dir)).toBe('');
	expect(await gitIn(f.dir, 'ls-files', '.cache')).toBe('');
});

test('C2b a snapshot never commits *.local or *.local.*, even when .gitignore does not name them', async () => {
	const f = await setup();
	await writeFile(join(f.dir, '.gitignore'), '.cache/\n');
	await gitIn(f.dir, 'commit', '-qam', 'a .gitignore without .local');
	await writeFile(join(f.dir, 'token.local.json'), '{"token":"secret"}\n');
	await writeFile(join(f.dir, 'device.local'), 'this computer\n');
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(await gitIn(f.dir, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'monday.md',
	);
	expect(await gitIn(f.dir, 'ls-files', '*.local*')).toBe('');
	expect(
		JSON.parse((await f.run('notes', '--json')).stdout),
	).not.toHaveProperty('history');
});

test('C3 a write that changes nothing makes no commit', async () => {
	const f = await setup();
	const head = await gitIn(f.dir, 'rev-parse', 'HEAD');
	const ran = await f.json('notes', 'same');
	expect(ran.code).toBe(0);
	expect(ran.answer).toEqual({ returned: null });
	expect(await gitIn(f.dir, 'rev-parse', 'HEAD')).toBe(head);
	// The call that changed nothing names no later snapshot.
	await writeFile(join(f.dir, 'b.md'), 'by hand\n');
	expect((await f.run('sync', 'notes')).code).toBe(0);
	expect(await gitIn(f.dir, 'log', '-1', '--format=%B')).toBe(
		'notes: 1 change\n\nChanged outside epicenter: b.md',
	);
});

test('C4 an app inside a larger repository commits only its own folder', async () => {
	const f = await setup({ git: false });
	await rm(f.dir, { recursive: true });
	const vault = await f.folder(join(f.root, 'vault'), {
		'journal/today.md': 'today\n',
		...Object.fromEntries(
			Object.entries(notesApp).map(([path, text]) => [`notes/${path}`, text]),
		),
	});
	const app = join(vault, 'notes');
	await symlink(app, join(f.home, 'notes'));

	await writeFile(join(vault, 'journal/today.md'), 'changed beside\n');
	await writeFile(join(vault, 'journal/staged.md'), 'staged beside\n');
	await gitIn(vault, 'add', 'journal/staged.md');
	await writeFile(join(app, 'a.md'), 'edited inside\n');
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(
		(await gitIn(vault, 'show', '--name-only', '--format=', 'HEAD')).split(
			'\n',
		),
	).toEqual(['notes/a.md', 'notes/monday.md']);
	expect(await gitIn(vault, 'log', '-1', '--format=%B')).toBe(
		'notes: write monday\n\nChanged outside epicenter: a.md',
	);
	expect(await status(vault)).toBe('A  journal/staged.md\n M journal/today.md');
});

test('C5 a snapshot that fails leaves the answer and exit code alone; the status says why until a later snapshot succeeds', async () => {
	const f = await setup();
	await writeFile(
		join(f.dir, '.gitattributes'),
		'*.png filter=lfs diff=lfs merge=lfs -text\n',
	);
	const kept = await f.json('notes', 'picture');
	expect(kept.code).toBe(0);
	expect(kept.answer).toEqual({ returned: null });
	expect(kept.stderr).toContain('run: git lfs install');
	expect(kept.stderr).toContain('Run: epicenter sync notes');
	expect(await gitIn(f.dir, 'diff', '--cached', '--name-only')).toBe('');
	expect(await subjects(f.dir)).toBe('initial');
	const threw = await f.json('notes', 'half', 'friday');
	expect(threw.code).toBe(1);
	expect(threw.answer).toEqual({ threw: { message: 'stopped halfway' } });
	expect(await subjects(f.dir)).toBe('initial');

	const listed = JSON.parse((await f.run('notes', '--json')).stdout);
	expect(listed.history).toEqual({
		pending: 3,
		failed: {
			message: expect.stringContaining('run: git lfs install'),
			next: 'epicenter sync notes',
		},
	});
	const human = (await f.run('notes')).stdout;
	expect(human).toContain('3 changes not yet in history');
	expect(human).toContain('The last snapshot failed: .gitattributes routes');
	expect(human).toContain('Run: epicenter sync notes');
	expect((await f.run()).stdout).toContain(
		'The notes app (3 changes not in history; last snapshot failed)',
	);

	// The calls stay logged, so the snapshot that succeeds names them.
	await rm(join(f.dir, '.gitattributes'));
	const synced = await f.json('sync', 'notes');
	expect(synced.code).toBe(0);
	expect(await gitIn(f.dir, 'log', '-1', '--format=%B')).toBe(
		'notes: 2 changes\n\nnotes: picture\nnotes: half friday',
	);
	expect(
		JSON.parse((await f.run('notes', '--json')).stdout),
	).not.toHaveProperty('history');
	expect((await f.run()).stdout).not.toContain('not in history');

	if (!Bun.which('git-lfs')) return;
	await writeFile(
		join(f.dir, '.gitattributes'),
		'*.png filter=lfs diff=lfs merge=lfs -text\n',
	);
	await gitIn(f.dir, 'lfs', 'install', '--local');
	await rm(join(f.dir, 'cover.png'));
	await gitIn(f.dir, 'commit', '-qam', 'no cover');
	const stored = await f.json('notes', 'picture');
	expect(stored).toMatchObject({ code: 0, stderr: '' });
	expect(await gitIn(f.dir, 'show', 'HEAD:cover.png')).toStartWith(
		'version https://git-lfs.github.com/spec/v1',
	);
});

test('C6 a snapshot waits for a held index lock, and after about 2 seconds leaves the write pending with Git’s message', async () => {
	const f = await setup();
	const lock = join(f.dir, '.git', 'index.lock');
	await writeFile(lock, '');
	const waiting = f.json('notes', 'write', 'monday');
	await Bun.sleep(1_000);
	await rm(lock);
	const saved = await waiting;
	expect(saved.code).toBe(0);
	expect(await subjects(f.dir)).toBe('notes: write monday\ninitial');

	await writeFile(lock, '');
	const held = await f.json('notes', 'write', 'tuesday');
	await rm(lock);
	expect(held.code).toBe(0);
	expect(held.answer).toEqual({ returned: 'tuesday' });
	expect(held.stderr).toContain('index.lock');
	expect(await readFile(join(f.dir, 'tuesday.md'), 'utf8')).toBe('tuesday');
	expect(
		JSON.parse((await f.run('notes', '--json')).stdout).history.failed.message,
	).toContain('index.lock');
});

test('C7 exit codes: 0 returned, 1 threw or ended without an answer, 2 did not run', async () => {
	const f = await setup();
	const tagged = await f.json('notes', 'tagged');
	expect(tagged.code).toBe(1);
	expect(tagged.answer).toEqual({
		threw: {
			message: 'no such page',
			thrown: { name: 'NotFound', message: 'no such page', page: 'x' },
		},
	});
	const exited = await f.json('notes', 'exit');
	expect(exited.code).toBe(1);
	expect(exited.answer).toEqual({
		threw: { message: 'The run ended without an answer (exit code 7)' },
	});
	const unknown = await f.json('notes', 'nope');
	expect(unknown.code).toBe(2);
	expect(unknown.answer.error).toMatchObject({ name: 'Usage' });
	const human = await f.run('notes', 'write', 'monday');
	expect(human).toEqual({ code: 0, stdout: 'monday\n', stderr: '' });
});

test('C9 a write that throws leaves what it wrote pending like any change, and the snapshot after it names the call', async () => {
	const f = await setup();
	const ran = await f.json('notes', 'half', 'wednesday');
	expect(ran.code).toBe(1);
	expect(ran.answer).toEqual({ threw: { message: 'stopped halfway' } });
	expect(await subjects(f.dir)).toBe('notes: half wednesday\ninitial');
	expect(await status(f.dir)).toBe('');
	await f.json('notes', 'write', 'thursday');
	expect(await gitIn(f.dir, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'thursday.md',
	);
	const human = await f.run('notes', 'half', 'friday');
	expect(human).toEqual({ code: 1, stdout: '', stderr: 'stopped halfway\n' });
});

test('C10 a read-only action cannot write through folder or secrets, and makes no commit', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'b.md'), 'by hand\n');
	const peek = await f.json('notes', 'peek');
	expect(peek.code).toBe(1);
	expect(peek.answer).toEqual({
		threw: {
			message: 'The action "peek" is read-only, so it cannot write peek.md',
		},
	});
	expect(await Bun.file(join(f.dir, 'peek.md')).exists()).toBe(false);
	const sneak = await f.json('notes', 'sneak');
	expect(sneak.answer).toEqual({
		threw: {
			message:
				'The action "sneak" is read-only, so it cannot set the secret token',
		},
	});
	expect(await subjects(f.dir)).toBe('initial');
	expect(await status(f.dir)).toBe('?? b.md');
});

test('C11 concurrent sets of different fields on one file all land', async () => {
	const f = await setup();
	const fields = Array.from({ length: 50 }, (_, i) => `f${i}`);
	await f.folder(join(f.home, 'many'), {
		'.gitignore': gitignore,
		'epicenter.ts': `${header}
const items = defineCollection({ path: 'items/{id}.md', fields: { ${fields.map((key) => `${key}: field.number({ optional: true })`).join(', ')} } });
export default defineApp({ description: 'Many fields', collections: { items }, actions: { items: items.actions() } });
`,
		'items/one.md': '---\n---\n',
	});
	const runs = await Promise.all(
		fields.map((key, i) =>
			f.run('many', 'items', 'set', 'items/one.md', `--${key}`, String(i)),
		),
	);
	expect(runs.filter((run) => run.code !== 0)).toEqual([]);
	const text = await readFile(join(f.home, 'many', 'items/one.md'), 'utf8');
	for (const [i, key] of fields.entries())
		expect(text).toContain(`${key}: ${i}\n`);
});

test('C12 no lock file is made anywhere', async () => {
	const f = await setup();
	const temp = join(f.root, 'tmp');
	await mkdir(temp);
	const env = { ...f.env, TMPDIR: temp };
	const run = (...args: string[]) =>
		Bun.spawn([process.execPath, f.bin, ...args], {
			cwd: f.root,
			env,
			stdout: 'ignore',
			stderr: 'ignore',
		}).exited;
	await Promise.all([
		run('notes', 'write', 'monday'),
		run('notes', 'write', 'tuesday'),
		run('notes', 'half', 'wednesday'),
	]);
	expect(await readdir(temp)).toEqual([]);
	expect(
		(await readdir(join(f.dir, '.git'))).filter((name) =>
			name.endsWith('.lock'),
		),
	).toEqual([]);
	expect(await status(f.dir)).toBe('');
});

test('C8 stdout belongs to epicenter: an action that logs does not corrupt --json or serve --stdio', async () => {
	const f = await setup();
	const json = await f.json('notes', 'chatty');
	expect(json.code).toBe(0);
	expect(json.answer).toEqual({ returned: 'answer' });
	for (const line of ['hello from log', 'hello from info', 'raw stdout'])
		expect(json.stderr).toContain(line);
	const client = new Client({ name: 'acceptance', version: '1' });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [f.bin, 'serve', '--stdio'],
				cwd: f.root,
				env: f.env as Record<string, string>,
				stderr: 'pipe',
			}),
		);
		const called = await client.callTool({
			name: 'notes_chatty',
			arguments: {},
		});
		expect(called.isError).toBeFalsy();
		expect(called.structuredContent).toEqual({ returned: 'answer' });
	} finally {
		await client.close();
	}
});
