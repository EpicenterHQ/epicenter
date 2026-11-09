/**
 * Acceptance, stage 2: the commit rule (ADR-0850). Black-box runs of the real
 * `epicenter` against a temporary HOME. A run commits nothing on its own; an
 * action that calls `folder.commit` commits everything changed in its folder
 * and nothing outside it. The answer is `{ returned }`, `{ threw }`, or
 * `{ error }`, exit 0, 1, or 2.
 */

import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

const notesCode = `import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';

export default defineApp(declaration, {
	actions: {
		write: {
			description: 'Write a page and leave it uncommitted',
			input: { page: field.text() },
			positional: ['page'],
			run: async ({ page }, { folder }) => {
				await folder.write(page + '.md', page);
				return page;
			},
		},
		save: {
			description: 'Write a page and commit the folder',
			input: { page: field.text() },
			positional: ['page'],
			run: async ({ page }, { folder }) => {
				await folder.write(page + '.md', page);
				await folder.write('.cache/seen.txt', page);
				await folder.commit('Save ' + page);
				return page;
			},
		},
		commit: {
			description: 'Commit the folder without writing',
			input: {},
			run: async (_, { folder }) => {
				await folder.commit('Commit what is there');
			},
		},
		picture: {
			description: 'Write a binary and commit it',
			input: {},
			run: async (_, { folder }) => {
				await folder.writeBytes('cover.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
				await folder.commit('Add a cover');
			},
		},
		tagged: {
			description: 'Throw a tagged error',
			input: {},
			run: () => {
				throw Object.freeze({ name: 'NotFound', message: 'no such page', page: 'x' });
			},
		},
		exit: {
			description: 'End the process without an answer',
			input: {},
			run: () => process.exit(7),
		},
		chatty: {
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
		},
	},
});
`;

const notesApp = {
	'.gitignore': gitignore,
	'a.md': 'base a\n',
	'epicenter.json': declarationOf('notes'),
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

test('C1 a run commits nothing, and needs no Git repository', async () => {
	const f = await setup();
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(ran.answer).toEqual({ returned: 'monday' });
	expect(ran.stderr).toBe('');
	expect(await subjects(f.dir)).toBe('initial');
	expect(await status(f.dir)).toBe('?? monday.md');

	const loose = await setup({ git: false });
	const plain = await loose.json('notes', 'write', 'tuesday');
	expect(plain.code).toBe(0);
	expect(plain.answer).toEqual({ returned: 'tuesday' });
	expect(await readFile(join(loose.dir, 'tuesday.md'), 'utf8')).toBe('tuesday');
});

test('C2 folder.commit commits everything changed in the folder, staged or not, and never ignored files', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'a.md'), 'edited by hand\n');
	await writeFile(join(f.dir, 'staged.md'), 'staged\n');
	await gitIn(f.dir, 'add', 'staged.md');
	const saved = await f.json('notes', 'save', 'monday');
	expect(saved.code).toBe(0);
	expect(saved.answer).toEqual({ returned: 'monday' });
	expect(await subjects(f.dir)).toBe('Save monday\ninitial');
	expect(
		(await gitIn(f.dir, 'show', '--name-only', '--format=', 'HEAD')).split(
			'\n',
		),
	).toEqual(['a.md', 'monday.md', 'staged.md']);
	expect(await status(f.dir)).toBe('');
	expect(await gitIn(f.dir, 'ls-files', '.cache')).toBe('');
});

test('C3 folder.commit with nothing changed is a no-op', async () => {
	const f = await setup();
	const head = await gitIn(f.dir, 'rev-parse', 'HEAD');
	const ran = await f.json('notes', 'commit');
	expect(ran.code).toBe(0);
	expect(ran.answer).toEqual({ returned: null });
	expect(await gitIn(f.dir, 'rev-parse', 'HEAD')).toBe(head);
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
	const saved = await f.json('notes', 'save', 'monday');
	expect(saved.code).toBe(0);
	expect(
		(await gitIn(vault, 'show', '--name-only', '--format=', 'HEAD')).split(
			'\n',
		),
	).toEqual(['notes/a.md', 'notes/monday.md']);
	expect(await status(vault)).toBe('A  journal/staged.md\n M journal/today.md');
});

test('C5 folder.commit outside any repository throws Git’s error, exit 1, and the write stays', async () => {
	const f = await setup({ git: false });
	const ran = await f.json('notes', 'save', 'monday');
	expect(ran.code).toBe(1);
	expect(ran.answer.threw.message).toContain('not a git repository');
	expect(await readFile(join(f.dir, 'monday.md'), 'utf8')).toBe('monday');
	const human = await f.run('notes', 'save', 'tuesday');
	expect(human.code).toBe(1);
	expect(human.stdout).toBe('');
	expect(human.stderr).toContain('not a git repository');
});

test('C6 folder.commit refuses before staging when .gitattributes routes a path through LFS and this computer has no filter', async () => {
	const f = await setup();
	await writeFile(
		join(f.dir, '.gitattributes'),
		'*.png filter=lfs diff=lfs merge=lfs -text\n',
	);
	const refused = await f.json('notes', 'picture');
	expect(refused.code).toBe(1);
	expect(refused.answer.threw.message).toContain('run: git lfs install');
	expect(await gitIn(f.dir, 'diff', '--cached', '--name-only')).toBe('');
	expect(await subjects(f.dir)).toBe('initial');

	if (!Bun.which('git-lfs')) return;
	await gitIn(f.dir, 'lfs', 'install', '--local');
	const stored = await f.json('notes', 'picture');
	expect(stored.code).toBe(0);
	expect(await gitIn(f.dir, 'show', 'HEAD:cover.png')).toStartWith(
		'version https://git-lfs.github.com/spec/v1',
	);
});

test('C7 folder.commit waits for a held index lock, and after about 2 seconds throws Git’s message', async () => {
	const f = await setup();
	const lock = join(f.dir, '.git', 'index.lock');
	await writeFile(lock, '');
	const waiting = f.json('notes', 'save', 'monday');
	await Bun.sleep(1_000);
	await rm(lock);
	const saved = await waiting;
	expect(saved.code).toBe(0);
	expect(await subjects(f.dir)).toBe('Save monday\ninitial');

	await writeFile(lock, '');
	const held = await f.json('notes', 'save', 'tuesday');
	await rm(lock);
	expect(held.code).toBe(1);
	expect(held.answer.threw.message).toContain('index.lock');
});

test('C8 exit codes: 0 returned, 1 threw or ended without an answer, 2 did not run', async () => {
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

test('C9 stdout belongs to epicenter: an action that logs does not corrupt --json or serve --stdio', async () => {
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
