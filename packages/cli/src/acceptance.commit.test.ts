/**
 * Acceptance, stage 2: commits (ADR-0850). Black-box runs of the real
 * `epicenter` against a temporary HOME. A write call snapshots data pending
 * before its first folder write, then commits everything pending in data
 * under its name. `epicenter sync` snapshots later outside edits. A
 * read-only action cannot write through `folder`, except to a `.local` path,
 * which no commit takes. The answer is
 * `{ returned }`, `{ threw }`, or `{ error }`, exit 0, 1, or 2, whatever
 * became of the commit.
 */

import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { hold } from './lock.ts';
import { fixture, gitIn, gitignore, header } from './runner.test-support.ts';

setDefaultTimeout(300_000);

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
			description: 'Write a page and a second data file',
			input: { page: field.text() },
			positional: ['page'],
			run: async ({ page }) => {
				await folder.write('data/' + page + '.md', page);
				await folder.write('data/node_modules/seen.txt', page);
				return page;
			},
		}),
		same: defineAction({
			description: 'Write a page as it already is',
			input: {},
			run: async () => {
				await folder.write('data/a.md', 'base a\\n');
			},
		}),
		picture: defineAction({
			description: 'Write a binary',
			input: {},
			run: async () => {
				await folder.writeBytes('data/cover.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
			},
		}),
		half: defineAction({
			description: 'Write a page, then throw',
			input: { page: field.text() },
			positional: ['page'],
			run: async ({ page }) => {
				await folder.write('data/' + page + '.md', page);
				throw new Error('stopped halfway');
			},
		}),
		peek: defineAction({
			description: 'Say it only reads, then write',
			input: {},
			annotations: { readOnlyHint: true },
			run: async () => {
				await folder.write('data/peek.md', 'peeked');
			},
		}),
		refresh: defineAction({
			description: 'Say it only reads, then keep a token on this computer',
			input: {},
			annotations: { readOnlyHint: true },
			run: () => folder.write('data/token.local.md', 'kept'),
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
		pair: defineAction({
			description: 'Write one page, wait until told to go on, then write another',
			input: { go: field.text() },
			run: async ({ go }) => {
				await folder.write('data/first.md', 'first');
				while (!(await Bun.file(go).exists())) await Bun.sleep(20);
				await folder.write('data/second.md', 'second');
			},
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
	'data/a.md': 'base a\n',
	'epicenter.ts': notesCode,
};

async function setup({ git = true }: { git?: boolean } = {}) {
	const f = await fixture();
	roots.push(f.root);
	const folder = await f.folder(join(f.home, 'notes'), notesApp, { git });
	if (git) {
		const data = join(folder, 'data');
		await writeFile(join(data, '.gitignore'), '*.local\n*.local.*\n');
		await gitIn(data, 'init', '-q');
		await gitIn(data, 'add', '-A');
		await gitIn(data, 'commit', '-q', '-m', 'notes: start its data');
	}
	const json = async (...args: string[]) => {
		const result = await f.run(...args, '--json');
		return { ...result, answer: JSON.parse(result.stdout) };
	};
	return { ...f, dir: folder, data: join(folder, 'data'), json };
}

const status = (folder: string) =>
	gitIn(folder, 'status', '--porcelain', '--untracked-files=all');
const subjects = (folder: string) => gitIn(folder, 'log', '--format=%s');

test('the call captures clean code before epicenter.ts moves HEAD while loading', async () => {
	const f = await setup();
	const moving = `const moved = Bun.spawnSync(['git', '-C', import.meta.dir, 'commit', '-q', '--allow-empty', '-m', 'moved while loading']);
if (moved.exitCode !== 0) throw new Error(new TextDecoder().decode(moved.stderr));
`;
	await writeFile(
		join(f.dir, 'epicenter.ts'),
		notesCode.replace('export default', `${moving}export default`),
	);
	await gitIn(f.dir, 'add', 'epicenter.ts');
	await gitIn(f.dir, 'commit', '-qm', 'move code while loading');
	const before = await gitIn(f.dir, 'rev-parse', 'HEAD');
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(ran.stderr).toBe('');
	expect(await gitIn(f.data, 'log', '-1', '--format=%B')).toBe(
		`notes: write monday\n\nCode-Commit: ${before}`,
	);
	expect(await gitIn(f.dir, 'rev-parse', 'HEAD')).not.toBe(before);
});

test('C1 a write call commits what it wrote as one commit named for the call', async () => {
	const f = await setup();
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(ran.answer).toEqual({ returned: 'monday' });
	expect(ran.stderr).toBe('');
	expect(await subjects(f.data)).toBe(
		'notes: write monday\nnotes: start its data',
	);
	expect(await gitIn(f.data, 'log', '-1', '--format=%B')).toContain(
		'notes: write monday',
	);
	expect(await status(f.data)).toBe('');
	expect(await status(f.dir)).toBe('');

	const loose = await setup({ git: false });
	const plain = await loose.json('notes', 'write', 'tuesday');
	expect(plain).toMatchObject({ code: 0, stderr: '' });
	expect(plain.answer).toEqual({ returned: 'tuesday' });
	expect(await readFile(join(loose.dir, 'data/tuesday.md'), 'utf8')).toBe(
		'tuesday',
	);
});

test('C2 a call snapshots pre-existing staged and unstaged data before its own commit', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'data/a.md'), 'edited by hand\n');
	await writeFile(join(f.dir, 'data/staged.md'), 'staged\n');
	await gitIn(f.data, 'add', 'staged.md');
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(await gitIn(f.data, 'log', '-1', '--format=%B')).toContain(
		'notes: write monday',
	);
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'monday.md\nnode_modules/seen.txt',
	);
	expect(await status(f.data)).toBe('');
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD~')).toBe(
		'a.md\nstaged.md',
	);
	expect(await subjects(f.data)).toBe(
		'notes: write monday\nnotes: changed outside epicenter\nnotes: start its data',
	);
	expect(await gitIn(f.data, 'ls-files', 'node_modules')).toBe(
		'node_modules/seen.txt',
	);
});

test('C2b a data snapshot refuses exposed *.local files and takes pending nonlocal files once ignored', async () => {
	const f = await setup();
	await writeFile(join(f.data, '.gitignore'), 'node_modules/\n');
	await gitIn(f.data, 'commit', '-qam', 'a .gitignore without .local');
	await writeFile(join(f.dir, 'data/token.local.json'), '{"token":"secret"}\n');
	await writeFile(join(f.dir, 'data/device.local'), 'this computer\n');
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'.gitignore',
	);
	expect(ran.stderr).toContain('not yet in history');
	const refused = await f.json('sync', 'notes');
	expect(refused.code).toBe(1);
	expect(refused.answer.apps[0].data.error.message).toBe(
		'notes/data: device.local would be committed; add *.local and *.local.* to notes/data/.gitignore',
	);
	expect(await subjects(f.data)).toBe(
		'a .gitignore without .local\nnotes: start its data',
	);
	await writeFile(join(f.data, '.gitignore'), '*.local\n*.local.*\n');
	const synced = await f.json('sync', 'notes');
	expect(synced.code).toBe(0);
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'.gitignore\nmonday.md\nnode_modules/seen.txt',
	);
	expect(await gitIn(f.data, 'ls-files', '*.local*')).toBe('');
	expect(JSON.parse((await f.run('notes', '--json')).stdout).status).toEqual({
		code: { pending: 0, backup: 'none' },
		data: { pending: 0, backup: 'none' },
	});
});

test('C3 a write that changes nothing makes no commit', async () => {
	const f = await setup();
	const head = await gitIn(f.data, 'rev-parse', 'HEAD');
	const ran = await f.json('notes', 'same');
	expect(ran.code).toBe(0);
	expect(ran.answer).toEqual({ returned: null });
	expect(await gitIn(f.data, 'rev-parse', 'HEAD')).toBe(head);
	// The call that changed nothing names no later snapshot.
	await writeFile(join(f.dir, 'data/b.md'), 'by hand\n');
	expect((await f.run('sync', 'notes')).code).toBe(0);
	expect(await gitIn(f.data, 'log', '-1', '--format=%B')).toContain(
		'notes: changed outside epicenter',
	);
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'b.md',
	);
});

test('C4 an app inside a larger repository leaves that repository untouched and commits data separately', async () => {
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
	await writeFile(join(app, 'data/a.md'), 'edited inside\n');
	const vaultHead = await gitIn(vault, 'rev-parse', 'HEAD');
	const ran = await f.json('notes', 'write', 'monday');
	expect(ran.code).toBe(0);
	expect(await gitIn(vault, 'rev-parse', 'HEAD')).toBe(vaultHead);
	expect(await gitIn(join(app, 'data'), 'log', '-1', '--format=%s')).toBe(
		'notes: write monday',
	);
	expect(
		await gitIn(join(app, 'data'), 'show', '--name-only', '--format=', 'HEAD'),
	).toBe('monday.md\nnode_modules/seen.txt');
	expect(await status(vault)).toBe('A  journal/staged.md\n M journal/today.md');
	// A snapshot with no call takes the data repository and nothing beside it.
	expect((await f.run('sync', 'notes')).code).toBe(0);
	expect(await gitIn(vault, 'rev-parse', 'HEAD')).toBe(vaultHead);
	expect(
		await gitIn(join(app, 'data'), 'show', '--name-only', '--format=', 'HEAD'),
	).toBe('monday.md\nnode_modules/seen.txt');
	expect(
		await gitIn(join(app, 'data'), 'show', '--name-only', '--format=', 'HEAD~'),
	).toBe('a.md');
	expect(await status(vault)).toBe('A  journal/staged.md\n M journal/today.md');
});

test('C5 a snapshot failure leaves the answer and pending paths for sync', async () => {
	const f = await setup();
	await writeFile(
		join(f.data, '.gitattributes'),
		'*.png filter=lfs diff=lfs merge=lfs -text\n',
	);
	const kept = await f.json('notes', 'picture');
	expect(kept.code).toBe(0);
	expect(kept.answer).toEqual({ returned: null });
	expect(kept.stderr).toContain(
		'notes: not yet in history: .gitattributes routes files through Git LFS, and this computer has no LFS filter, so Git would store them whole\nRun: git lfs install\n',
	);
	expect(await gitIn(f.data, 'diff', '--cached', '--name-only')).toBe('');
	expect(await subjects(f.data)).toBe('notes: start its data');
	const threw = await f.json('notes', 'half', 'friday');
	expect(threw.code).toBe(1);
	expect(threw.answer).toEqual({ threw: { message: 'stopped halfway' } });
	expect(await subjects(f.data)).toBe('notes: start its data');

	const listed = JSON.parse((await f.run('notes', '--json')).stdout);
	expect(listed.status).toEqual({
		code: { pending: 0, backup: 'none' },
		data: { pending: 3, backup: 'none' },
	});
	const human = (await f.run('notes')).stdout;
	expect(human).toContain('data: 3 changes not yet in history');
	expect(human).toContain(
		`git -C ${f.dir} remote add origin <url> and git -C ${f.data} remote add origin <url>`,
	);
	expect((await f.run()).stdout).toContain(
		'The notes app (code: not backed up; data: 3 changes not yet in history; data: not backed up)',
	);

	// Sync's snapshot has no call, so it takes every pending path.
	await rm(join(f.data, '.gitattributes'));
	const synced = await f.json('sync', 'notes');
	expect(synced.code).toBe(0);
	expect(await gitIn(f.data, 'log', '-1', '--format=%B')).toContain(
		'notes: changed outside epicenter',
	);
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'cover.png\nfriday.md',
	);
	expect(JSON.parse((await f.run('notes', '--json')).stdout).status).toEqual({
		code: { pending: 0, backup: 'none' },
		data: { pending: 0, backup: 'none' },
	});
	expect((await f.run()).stdout).not.toContain('not yet in history');

	if (!Bun.which('git-lfs')) return;
	await writeFile(
		join(f.data, '.gitattributes'),
		'*.png filter=lfs diff=lfs merge=lfs -text\n',
	);
	await gitIn(f.data, 'lfs', 'install', '--local');
	await rm(join(f.dir, 'data/cover.png'));
	await gitIn(f.data, 'commit', '-qam', 'no cover');
	const stored = await f.json('notes', 'picture');
	expect(stored).toMatchObject({ code: 0, stderr: '' });
	expect(await gitIn(f.data, 'show', 'HEAD:cover.png')).toStartWith(
		'version https://git-lfs.github.com/spec/v1',
	);
});

test('C6 a snapshot waits for a held index lock, and after about 2 seconds leaves the write pending with Git’s message', async () => {
	const f = await setup();
	const lock = join(f.data, '.git', 'index.lock');
	await writeFile(lock, '');
	const waiting = f.json('notes', 'write', 'monday');
	await Bun.sleep(1_000);
	await rm(lock);
	const saved = await waiting;
	expect(saved.code).toBe(0);
	expect(await subjects(f.data)).toBe(
		'notes: write monday\nnotes: start its data',
	);

	await writeFile(lock, '');
	const held = await f.json('notes', 'write', 'tuesday');
	await rm(lock);
	expect(held.code).toBe(0);
	expect(held.answer).toEqual({ returned: 'tuesday' });
	expect(held.stderr).toContain('index.lock');
	expect(await readFile(join(f.dir, 'data/tuesday.md'), 'utf8')).toBe(
		'tuesday',
	);
	expect(JSON.parse((await f.run('notes', '--json')).stdout).status).toEqual({
		code: { pending: 0, backup: 'none' },
		data: { pending: 2, backup: 'none' },
	});
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

test('C9 a write that throws is committed as the call that threw', async () => {
	const f = await setup();
	const ran = await f.json('notes', 'half', 'wednesday');
	expect(ran.code).toBe(1);
	expect(ran.answer).toEqual({ threw: { message: 'stopped halfway' } });
	expect(await subjects(f.data)).toBe(
		'notes: half wednesday (threw)\nnotes: start its data',
	);
	expect(await status(f.data)).toBe('');
	await f.json('notes', 'write', 'thursday');
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'node_modules/seen.txt\nthursday.md',
	);
	const human = await f.run('notes', 'half', 'friday');
	expect(human).toEqual({ code: 1, stdout: '', stderr: 'stopped halfway\n' });
});

test('C10 a read-only action cannot write through folder, except a .local file, and makes no commit', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'data/b.md'), 'by hand\n');
	// A refused write is refused at once, not after waiting on another call's lock.
	const held = await hold(f.dir, 0);
	const peek = await f.json('notes', 'peek');
	held?.release();
	expect(peek.code).toBe(1);
	expect(peek.answer).toEqual({
		threw: {
			message:
				'The action "peek" is read-only, so it cannot write data/peek.md',
		},
	});
	expect(await Bun.file(join(f.dir, 'data/peek.md')).exists()).toBe(false);
	const refresh = await f.json('notes', 'refresh');
	expect(refresh).toMatchObject({ code: 0, answer: { returned: null } });
	expect(await readFile(join(f.dir, 'data/token.local.md'), 'utf8')).toBe(
		'kept',
	);
	expect((await stat(join(f.dir, 'data/token.local.md'))).mode & 0o777).toBe(
		0o600,
	);
	expect(await subjects(f.data)).toBe('notes: start its data');
	expect(await status(f.data)).toBe('?? b.md');
});

test('C11 concurrent sets of different fields on one file all land', async () => {
	const f = await setup();
	const fields = Array.from({ length: 50 }, (_, i) => `f${i}`);
	await f.folder(join(f.home, 'many'), {
		'.gitignore': gitignore,
		'epicenter.ts': `${header}
const items = defineCollection({ path: 'data/items/{id}.md', fields: { ${fields.map((key) => `${key}: field.number({ optional: true })`).join(', ')} } });
export default defineApp({ description: 'Many fields', collections: { items }, actions: { items: items.actions() } });
`,
		'data/items/one.md': '---\n---\n',
	});
	const runs = await Promise.all(
		fields.map((key, i) =>
			f.run('many', 'items', 'set', 'data/items/one.md', `--${key}`, String(i)),
		),
	);
	// Every commit lands too: the commits take turns, and none fails.
	expect(runs.filter((run) => run.code !== 0 || run.stderr !== '')).toEqual([]);
	const text = await readFile(
		join(f.home, 'many', 'data/items/one.md'),
		'utf8',
	);
	for (const [i, key] of fields.entries())
		expect(text).toContain(`${key}: ${i}\n`);
	expect(await status(join(f.home, 'many', 'data'))).toBe('');
});

test('C12 runs leave no temporary file and no lock file, and hold no lock once they answer', async () => {
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
	// macOS Git's launcher keeps its own cache in TMPDIR.
	expect((await readdir(temp)).filter((name) => name !== 'xcrun_db')).toEqual(
		[],
	);
	expect(
		(await readdir(join(f.data, '.git'))).filter((name) =>
			name.endsWith('.lock'),
		),
	).toEqual([]);
	// The app's lock is the folder's own, and no one holds it.
	const held = await hold(f.dir, 0);
	expect(held).toBeDefined();
	held?.release();
	expect(await status(f.data)).toBe('');
});

test('C13 sync -m names a snapshot of what an agent edited, and refuses a message that is not one line or has no app', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'data/a.md'), 'tidied\n');
	await writeFile(join(f.dir, 'data/b.md'), 'new\n');
	for (const words of [
		['sync', '-m', 'one\ntwo', 'notes'],
		['sync', 'notes', '-m', 'one\ntwo'],
		['sync', 'notes', '--message', '  '],
		['sync', '-m', 'tidy'],
		['sync', 'notes', '-m'],
	]) {
		const refused = await f.json(...words);
		expect(refused.code).toBe(2);
		expect(refused.answer.error).toMatchObject({ name: 'Usage' });
	}
	expect(await subjects(f.data)).toBe('notes: start its data');
	const synced = await f.run('sync', 'notes', '-m', 'tidy the pages');
	expect(synced.code).toBe(0);
	expect(synced.stdout).toBe(
		'notes: nothing to commit; no origin\nnotes/data: committed notes: tidy the pages; no origin\n',
	);
	expect(await gitIn(f.data, 'log', '-1', '--format=%B')).toContain(
		'notes: tidy the pages',
	);
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'a.md\nb.md',
	);
	await writeFile(join(f.dir, 'data/c.md'), 'c\n');
	expect((await f.run('sync', 'notes', '--message=add c')).code).toBe(0);
	expect(await gitIn(f.data, 'log', '-1', '--format=%s')).toBe('notes: add c');
	// An undo treats it as a snapshot.
	expect((await f.run('undo', 'notes')).stdout).toBe('undid notes: add c\n');
});

test("C14 a sync in another process while a call runs leaves the call's writes to the call's one commit", async () => {
	const f = await setup();
	const go = join(f.root, 'go');
	const call = f.run('notes', 'pair', '--go', go);
	while (!(await Bun.file(join(f.dir, 'data/first.md')).exists()))
		await Bun.sleep(20);
	// The call is between its two writes: sync waits for it, or would take the first.
	const sync = f.run('sync', 'notes');
	await Promise.race([sync, Bun.sleep(1_500)]);
	await writeFile(go, '');
	expect(await call).toMatchObject({ code: 0, stderr: '' });
	expect(await sync).toMatchObject({
		code: 0,
		stdout:
			'notes: nothing to commit; no origin\nnotes/data: nothing to commit; no origin\n',
	});
	expect(await subjects(f.data)).toBe('notes: pair\nnotes: start its data');
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'first.md\nsecond.md',
	);
	expect(await status(f.data)).toBe('');
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
