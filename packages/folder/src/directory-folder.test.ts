/**
 * The folder over an ordinary directory: files through the browser folder's
 * storage over directory primitives, history through real Git. Here the
 * primitives are `node:fs` and Git is the system `git`, as in the
 * `epicenter` CLI that runs a desktop page's history. Every check
 * reads the result with native Git, since another Git program shares the
 * repository.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { SCRATCH_DIRECTORY } from './boundary.js';
import { defineFolder, defineTable, field } from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import { openDirectoryFolder } from './directory-adapter.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import type { DirectoryPrimitives } from './directory-primitives.js';
import {
	createDirectoryStorage,
	sweepStaleScratch,
} from './directory-store.js';
import { nativeHistory } from './git/native-history.js';
import { createGitRunner } from './git/native-host.js';
import { NEUTRAL_ATTRIBUTES } from './git/neutral-attributes.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	scratch,
} from './git-http.test-support.js';
import { mustRow } from './row-write.test-support.js';

const definition = defineFolder({
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const author = { name: 'Todos', email: 'todos@localhost' };

const originalEnv = { ...process.env };

beforeAll(() => {
	// The folder's own `git` and the checks here must not pick up the
	// developer's hooks, signing, or identity.
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

async function open(
	root: string,
	options: {
		primitives?: DirectoryPrimitives;
		/** Runs before each `git` command this handle runs. */
		beforeGit?: (args: readonly string[]) => Promise<void>;
	} = {},
) {
	const files = options.primitives ?? nodeDirectoryPrimitives;
	// As the Bun opener does before it opens.
	await sweepStaleScratch(root, files);
	const system = createGitRunner(root);
	const run: typeof system = async (args, runOptions) => {
		await options.beforeGit?.(args);
		return system(args, runOptions);
	};
	// This process is the directory's only writer, so Sync's save lock is no
	// lock at all.
	const storage = createDirectoryStorage({
		root,
		primitives: files,
		hold: { lock: <T>(work: () => Promise<T>) => work(), held: files },
	});
	return openDirectoryFolder<typeof definition>({
		opening: {
			id: 'directory',
			own: true,
			definition: expectOk(prepareFolderDefinition(definition)),
		},
		rootPath: root,
		storage,
		history: nativeHistory({
			rootPath: root,
			host: { run, files },
			boundary: storage,
			author,
		}),
	});
}

const HOUR = 60 * 60 * 1000;

/** A staged file's name as another process's handle makes it, `offset` from now. */
const stagedName = (offset: number) =>
	`${(Date.now() + offset).toString(36)}-${'0'.repeat(32)}-0`;

type OpenedFolder = NonNullable<Awaited<ReturnType<typeof open>>['data']>;

async function addTodo(folder: OpenedFolder, title: string) {
	return mustRow(
		await folder.tables.todos.create({
			fields: { title, done: false },
			body: '',
		}),
	);
}

/** The stem of a row path in `todos`. */
const stemOf = (path: string) => path.slice('todos/'.length, -'.md'.length);

/** A repository native Git made, with one committed file. */
async function nativeRepository(prefix: string) {
	const root = await scratch(prefix);
	await git(root, 'init', '--quiet', '--initial-branch=main');
	await writeFile(join(root, 'notes.txt'), 'kept\n');
	await git(root, 'add', 'notes.txt');
	await git(root, 'commit', '--quiet', '-m', 'Native start');
	return { root, start: await git(root, 'rev-parse', 'HEAD') };
}

describe('a folder over an ordinary directory', () => {
	test('writes real files and a repository native Git reads cleanly', async () => {
		const root = await scratch('directory-folder-');
		const folder = expectOk(await open(root));
		expect(folder.location).toEqual({ kind: 'directory', root });
		expect(existsSync(join(root, 'todos'))).toBe(false);
		expect(expectOk(await folder.tables.todos.list())).toEqual([]);
		expect(existsSync(join(root, 'todos'))).toBe(false);
		// Opening and reading wrote nothing, and created no repository.
		expect(existsSync(join(root, '.git'))).toBe(false);
		const created = await addTodo(folder, 'Buy milk');
		// The first write published the declaration before its own file.
		expect(existsSync(join(root, 'epicenter.json'))).toBe(true);
		expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
		expect(existsSync(join(root, 'todos'))).toBe(true);
		expect(await readFile(join(root, created.path), 'utf8')).toContain(
			'title: Buy milk',
		);

		expect((await folder.git.commit()).status).toBe('committed');
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await git(root, 'fsck', '--strict');
		expect(await git(root, 'log', '--format=%an <%ae>', '-1')).toBe(
			'Todos <todos@localhost>',
		);
		expect(await readdir(join(root, SCRATCH_DIRECTORY))).toEqual([]);
		await folder.close();
	});

	test('opens a repository native Git made, with its author, and continues its branch', async () => {
		const { root, start } = await nativeRepository(
			'directory-folder-existing-',
		);
		await git(root, 'config', 'user.name', 'Braden');
		await git(root, 'config', 'user.email', 'braden@example.test');

		const folder = expectOk(await open(root));
		await addTodo(folder, 'From Todos');
		expect(await folder.git.commit()).toMatchObject({
			status: 'committed',
			parent: start,
		});
		expect(await git(root, 'log', '--format=%an <%ae>', '-1')).toBe(
			'Braden <braden@example.test>',
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await git(root, 'fsck', '--strict');
		expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('kept\n');
		await folder.close();
	});

	test("a new folder's first open commits as the person's global Git identity", async () => {
		const root = await scratch('directory-folder-identity-');
		const global = join(await scratch('directory-folder-global-'), 'gitconfig');
		await writeFile(
			global,
			'[user]\n\tname = Braden\n\temail = braden@example.test\n',
		);
		process.env.GIT_CONFIG_GLOBAL = global;
		try {
			const folder = expectOk(await open(root));
			await addTodo(folder, 'First');
			expect((await folder.git.commit()).status).toBe('committed');
			expect(await git(root, 'log', '--format=%an <%ae>', '-1')).toBe(
				'Braden <braden@example.test>',
			);
			await folder.close();
		} finally {
			process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
		}
	});

	test('a branch native Git packed (git gc) is continued, not forked', async () => {
		const { root, start } = await nativeRepository('directory-folder-packed-');
		await git(root, 'pack-refs', '--all');
		await git(root, 'gc', '--quiet');
		const folder = expectOk(await open(root));
		await addTodo(folder, 'After gc');
		expect(await folder.git.commit()).toMatchObject({
			status: 'committed',
			parent: start,
		});
		expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('2');
		await git(root, 'merge-base', '--is-ancestor', start, 'HEAD');
		await git(root, 'fsck', '--strict');
		await folder.close();
	});

	test('a commit native Git makes while the folder is open is the next parent', async () => {
		const { root } = await nativeRepository('directory-folder-concurrent-');
		const folder = expectOk(await open(root));
		await writeFile(join(root, 'native.txt'), 'native\n');
		await git(root, 'add', 'native.txt');
		await git(root, 'commit', '--quiet', '-m', 'Native while open');
		const native = await git(root, 'rev-parse', 'HEAD');
		await addTodo(folder, 'After the native commit');
		expect(await folder.git.commit()).toMatchObject({
			status: 'committed',
			parent: native,
		});
		await git(root, 'fsck', '--strict');
		await folder.close();
	});

	test("while another Git program holds the index, a commit lands by Git's ref lock and the next one refreshes the index", async () => {
		const { root, start } = await nativeRepository('directory-folder-lock-');
		const folder = expectOk(await open(root));
		await addTodo(folder, 'Beside a busy index');
		await writeFile(join(root, '.git', 'index.lock'), '');
		// The commit's objects and its compare-and-swap of the branch need no
		// index; refreshing the index is refused, and the outcome says why.
		const committed = await folder.git.commit();
		expect(committed).toMatchObject({ status: 'committed', parent: start });
		expect(JSON.stringify(committed)).toContain('index.lock');
		await Bun.file(join(root, '.git', 'index.lock')).delete();
		expect((await folder.git.commit()).status).toBe('unchanged');
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await git(root, 'fsck', '--strict');
		await folder.close();
	});

	test('opening and committing leave the Git configuration as the person set it', async () => {
		const { root } = await nativeRepository('directory-folder-config-');
		await git(root, 'remote', 'add', 'origin', 'https://example.test/r.git');
		await git(
			root,
			'config',
			'--add',
			'remote.origin.fetch',
			'+refs/pull/*/head:refs/remotes/origin/pr/*',
		);
		const before = await readFile(join(root, '.git', 'config'), 'utf8');
		const folder = expectOk(await open(root));
		await addTodo(folder, 'Config untouched');
		expect((await folder.git.commit()).status).toBe('committed');
		expect(await readFile(join(root, '.git', 'config'), 'utf8')).toBe(before);
		await folder.close();
	});

	test('a repository that tracks an executable refuses the commit and names it', async () => {
		const root = await scratch('directory-folder-modes-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		await writeFile(join(root, 'run.sh'), '#!/bin/sh\n');
		await chmod(join(root, 'run.sh'), 0o755);
		await git(root, 'add', 'run.sh');
		await git(root, 'commit', '--quiet', '-m', 'Executable');
		const head = await git(root, 'rev-parse', 'HEAD');

		const folder = expectOk(await open(root));
		await addTodo(folder, 'Beside a script');
		const refused = await folder.git.commit();
		expect(refused.status).toBe('blocked');
		expect(JSON.stringify(refused)).toContain('run.sh');
		expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
		expect(await git(root, 'ls-files', '--stage', 'run.sh')).toStartWith(
			'100755',
		);
		await folder.close();
	});

	test.each([
		'global',
		'repository',
	] as const)("with core.autocrlf=true in the person's %s config, Save version and Sync commit each file as it is on disk, and the person's checkout writes it back the same", async (where) => {
		const project = await scratch('directory-folder-autocrlf-');
		const bare = await createBareRemote(project);
		const root = join(project, 'desktop');
		await mkdir(root);
		// Git for Windows writes this when it installs.
		const global = process.env.GIT_CONFIG_GLOBAL;
		if (where === 'global') {
			const config = join(project, 'gitconfig');
			await writeFile(config, '[core]\n\tautocrlf = true\n');
			process.env.GIT_CONFIG_GLOBAL = config;
		}
		/** The person's own `git`, with their configuration. */
		const theirs = async (...args: string[]) => {
			const child = Bun.spawn(['git', ...args], {
				cwd: root,
				env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL },
				stderr: 'pipe',
			});
			expect([
				await child.exited,
				await new Response(child.stderr).text(),
			]).toEqual([0, '']);
		};
		try {
			const ran: (readonly string[])[] = [];
			const folder = expectOk(
				await open(root, { beforeGit: async (args) => void ran.push(args) }),
			);
			const created = await addTodo(folder, 'Line feeds');
			// The folder's first commit creates its repository.
			expect((await folder.git.commit()).status).toBe('committed');
			expect(await readFile(join(root, '.git/info/attributes'), 'utf8')).toBe(
				NEUTRAL_ATTRIBUTES,
			);
			if (where === 'repository')
				await git(root, 'config', 'core.autocrlf', 'true');
			await writeFile(join(root, 'windows.txt'), 'one\r\ntwo\r\n');
			// An attribute the person's checkout would apply, but for the
			// repository's own `info/attributes`.
			await writeFile(join(root, '.gitattributes'), '*.md text eol=crlf\n');
			/** Whether `path`'s blob in `commit` is its bytes on disk. */
			const stored = async (commit: string, path: string) =>
				(await git(root, 'rev-parse', `${commit}:${path}`)) ===
				(await git(root, 'hash-object', '--no-filters', path));

			expect(
				(await folder.git.commit({ message: 'Keep line endings' })).status,
			).toBe('committed');
			for (const path of [created.path, 'windows.txt'])
				expect([path, await stored('HEAD', path)]).toEqual([path, true]);

			// A native checkout with no conversion of its own sends a file back.
			const native = join(project, 'native');
			expect(expectOk(await folder.sync.connect(bare)).kind).toBe('synced');
			await git(project, 'clone', '--quiet', bare, native);
			await writeFile(join(native, 'incoming.txt'), 'a\nb\n');
			await git(native, 'add', 'incoming.txt');
			await git(native, 'commit', '--quiet', '-m', 'Incoming');
			await git(native, 'push', '--quiet', 'origin', 'main');
			await writeFile(join(root, 'windows.txt'), 'one\r\ntwo\r\nthree\r\n');

			expect(expectOk(await folder.sync.run()).kind).toBe('synced');
			expect(await readFile(join(root, 'incoming.txt'), 'utf8')).toBe('a\nb\n');
			expect(await git(bare, 'rev-parse', 'main')).toBe(
				await git(root, 'rev-parse', 'main'),
			);
			const tracked = [created.path, 'windows.txt', 'incoming.txt'];
			for (const path of tracked)
				expect([path, await stored('main', path)]).toEqual([path, true]);
			// No command needs Git 2.40's `check-attr --source`.
			expect(ran.filter((args) => args.includes('check-attr'))).toEqual([]);
			await folder.close();

			// The person checks the files out again with their own Git.
			for (const path of tracked) await rm(join(root, path));
			await theirs('checkout', '--', ...tracked);
			for (const path of tracked)
				expect([path, await stored('main', path)]).toEqual([path, true]);
		} finally {
			if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = global;
		}
	});

	test('an attribute file that names a filter, ignored or not, refuses the commit; line-ending attributes commit the bytes on disk', async () => {
		const { root, start } = await nativeRepository('directory-folder-filter-');
		await writeFile(join(root, '.gitattributes'), '*.md text eol=crlf\n');
		const folder = expectOk(await open(root));
		const created = await addTodo(folder, 'Plain bytes');
		const committed = await folder.git.commit();
		expect(committed).toMatchObject({ status: 'committed', parent: start });
		expect(await git(root, 'rev-parse', `HEAD:${created.path}`)).toBe(
			await git(root, 'hash-object', '--no-filters', created.path),
		);
		const head = await git(root, 'rev-parse', 'HEAD');

		await writeFile(
			join(root, '.gitattributes'),
			'*.md text eol=crlf\n*.wav filter=lfs\n',
		);
		await addTodo(folder, 'Beside a filter');
		const refused = await folder.git.commit();
		expect(refused.status).toBe('blocked');
		expect(JSON.stringify(refused)).toContain(
			'.gitattributes line 2 (*.wav filter=lfs) names a Git filter',
		);
		expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);

		// An ignored attribute file refuses too: Git reads it all the same.
		await writeFile(join(root, '.gitattributes'), '*.md text eol=crlf\n');
		await writeFile(join(root, '.gitignore'), 'local/\n');
		await mkdir(join(root, 'local'));
		await writeFile(join(root, 'local/.gitattributes'), '* filter=lfs\n');
		const ignored = await folder.git.commit();
		expect(ignored.status).toBe('blocked');
		expect(JSON.stringify(ignored)).toContain(
			'local/.gitattributes line 1 (* filter=lfs) names a Git filter',
		);
		expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
		await folder.close();
	});

	test('a write merges with a file another program changed', async () => {
		const root = await scratch('directory-folder-guard-');
		const folder = expectOk(await open(root));
		const created = await addTodo(folder, 'Mine');
		const path = join(root, created.path);
		await writeFile(path, '---\ntitle: Mine\ndone: true\n---\n');
		expectOk(
			await folder.tables.todos.write(stemOf(created.path), created.row, {
				...created.row,
				fields: { ...created.row.fields, title: 'Mine, edited' },
			}),
		);
		expect(await readFile(path, 'utf8')).toBe(
			'---\ntitle: Mine, edited\ndone: true\n---\n',
		);
		await folder.close();
	});

	test('a write another writer overtakes after its check merges; a create is refused where it publishes, and a delete reads again and wins', async () => {
		const root = await scratch('directory-folder-overtaken-');
		// Another writer, sharing no lock with this folder, lands these bytes
		// on a path after this folder checked it and before it publishes.
		const overtaken = new Map<string, string>();
		const overtake = async (path: string) => {
			const theirs = overtaken.get(path);
			if (theirs === undefined) return;
			overtaken.delete(path);
			await writeFile(path, theirs);
		};
		const racing: DirectoryPrimitives = {
			...nodeDirectoryPrimitives,
			async rename(from, to, expected) {
				await overtake(to);
				return nodeDirectoryPrimitives.rename(from, to, expected);
			},
			async remove(path, options) {
				await overtake(path);
				return nodeDirectoryPrimitives.remove(path, options);
			},
		};
		const folder = expectOk(await open(root, { primitives: racing }));

		const created = await addTodo(folder, 'Mine');
		const path = join(root, created.path);
		const theirs = '---\ntitle: Theirs\ndone: false\n---\n';
		overtaken.set(path, theirs);
		expectOk(
			await folder.tables.todos.write(stemOf(created.path), created.row, {
				...created.row,
				fields: { ...created.row.fields, title: 'Mine, edited' },
			}),
		);
		expect(await readFile(path, 'utf8')).toContain('title: Mine, edited');

		const note = join(root, 'todos/a.md');
		overtaken.set(note, 'theirs\n');
		// A create lands only where no file is.
		const made = await folder.write('todos/a.md', null, 'mine\n');
		expect(made.error?.name).toBe('Occupied');
		expect(await readFile(note, 'utf8')).toBe('theirs\n');

		// A delete reads again, and the deleter wins over what landed meanwhile.
		overtaken.set(note, 'theirs again\n');
		const deleted = expectOk(
			await folder.write('todos/a.md', 'theirs\n', null),
		);
		expect(deleted.file).toBeNull();
		expect(await Bun.file(note).exists()).toBe(false);

		// A write merges with whatever is there, and wins the lines both changed.
		expectOk(await folder.write('todos/a.md', null, 'base\n'));
		overtaken.set(note, 'theirs once more\n');
		const mine = expectOk(await folder.write('todos/a.md', 'base\n', 'mine\n'));
		expect(mine.overridden).not.toEqual([]);
		expect(await readFile(note, 'utf8')).toBe('mine\n');
		expect(await readdir(join(root, SCRATCH_DIRECTORY))).toEqual([]);
		await folder.close();
	});

	test('a write that stops before it lands leaves nothing at its path, and the next open clears what it staged', async () => {
		const root = await scratch('directory-folder-interrupted-');
		// The rename that publishes a todo is lost, as a quit would lose it.
		const failing: DirectoryPrimitives = {
			...nodeDirectoryPrimitives,
			async rename(from, to, expected) {
				if (to.includes('/todos/')) throw new Error('quit before the rename');
				return nodeDirectoryPrimitives.rename(from, to, expected);
			},
		};
		const interrupted = expectOk(await open(root, { primitives: failing }));
		const refused = await interrupted.tables.todos.create({
			fields: { title: 'Never landed', done: false },
			body: '',
		});
		expect(refused.error).not.toBeNull();
		// Neither an empty file nor a partial one is at the path.
		const todos = await readdir(join(root, 'todos')).catch(() => []);
		expect(todos.filter((name) => name.endsWith('.md'))).toEqual([]);
		await interrupted.close();

		// A staged file a crash left is removed when the folder opens again,
		// once it is old enough that no write can still be about to rename it.
		await mkdir(join(root, SCRATCH_DIRECTORY), { recursive: true });
		await writeFile(join(root, SCRATCH_DIRECTORY, stagedName(-2 * HOUR)), 'x');
		const reopened = expectOk(await open(root));
		expect(await readdir(join(root, SCRATCH_DIRECTORY))).toEqual([]);
		await reopened.close();
	});

	test('an open leaves a file another process just staged, and names it did not make', async () => {
		const root = await scratch('directory-folder-foreign-scratch-');
		await mkdir(join(root, SCRATCH_DIRECTORY), { recursive: true });
		// Another process wrote this between its write and its rename; it
		// shares no lock with this one.
		const fresh = stagedName(0);
		const old = stagedName(-2 * HOUR);
		for (const name of [fresh, old, 'left-behind'])
			await writeFile(join(root, SCRATCH_DIRECTORY, name), 'x');
		const folder = expectOk(await open(root));
		expect((await readdir(join(root, SCRATCH_DIRECTORY))).sort()).toEqual(
			[fresh, 'left-behind'].sort(),
		);
		await folder.close();
	});

	test('two windows opening a new folder at once share one repository', async () => {
		const root = await scratch('directory-folder-race-');
		const [first, second] = await Promise.all([open(root), open(root)]);
		const a = expectOk(first);
		const b = expectOk(second);
		await addTodo(a, 'From one window');
		expect((await b.git.commit()).status).toBe('committed');
		expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await git(root, 'fsck', '--strict');
		await a.close();
		await b.close();
	});

	test('a commit whose branch another window moved retries from a fresh capture', async () => {
		const root = await scratch('directory-folder-commit-race-');
		const a = expectOk(await open(root));
		await addTodo(a, 'First');
		expect((await a.git.commit()).status).toBe('committed');
		// Window A commits after B captured and before B moves the branch,
		// then saves once more: B's retry must record that save.
		let interleave = true;
		const b = expectOk(
			await open(root, {
				async beforeGit(args) {
					if (!interleave || args[0] !== 'update-ref') return;
					interleave = false;
					await addTodo(a, 'Committed by A');
					expect((await a.git.commit()).status).toBe('committed');
					await addTodo(a, 'Saved after A committed');
				},
			}),
		);
		await addTodo(b, 'Saved by B');
		const before = await git(root, 'rev-parse', 'HEAD');
		const outcome = await b.git.commit();
		const fromA = await git(root, 'rev-parse', 'HEAD^');
		expect(outcome).toMatchObject({ status: 'committed', parent: fromA });
		expect(await git(root, 'rev-parse', 'HEAD^^')).toBe(before);
		expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('3');
		expect(await git(root, 'rev-list', '--merges', '--count', 'HEAD')).toBe(
			'0',
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		const titles = await git(
			root,
			'grep',
			'-h',
			'^title:',
			'HEAD',
			'--',
			'todos',
		);
		for (const title of [
			'First',
			'Committed by A',
			'Saved after A committed',
			'Saved by B',
		])
			expect(titles).toContain(`title: ${title}`);
		await git(root, 'fsck', '--strict');
		await a.close();
		await b.close();
	});

	test('two windows that commit at once both land on one linear history', async () => {
		const root = await scratch('directory-folder-commits-');
		const a = expectOk(await open(root));
		const b = expectOk(await open(root));
		for (let round = 0; round < 5; round++) {
			await Promise.all([addTodo(a, `A ${round}`), addTodo(b, `B ${round}`)]);
			const outcomes = await Promise.all([a.git.commit(), b.git.commit()]);
			for (const outcome of outcomes)
				expect(['committed', 'unchanged']).toContain(outcome.status);
		}
		expect(await git(root, 'rev-list', '--merges', '--count', 'HEAD')).toBe(
			'0',
		);
		expect(
			await git(root, 'status', '--porcelain', '--untracked-files=all'),
		).toBe('');
		await git(root, 'fsck', '--strict');
		await a.close();
		await b.close();
	});

	test('an incoming update that stops partway is finished by the next Sync', async () => {
		const project = await scratch('directory-folder-incoming-');
		const bare = await createBareRemote(project);
		const root = join(project, 'desktop');
		await git(project, 'init', '--quiet', '--initial-branch=main', root);
		await git(root, 'remote', 'add', 'origin', bare);
		const first = expectOk(await open(root));
		await addTodo(first, 'Shared');
		expectOk(await first.sync.run());
		await first.close();

		// Another checkout adds two todos and pushes.
		const native = join(project, 'native');
		await git(project, 'clone', '--quiet', bare, native);
		for (const name of ['a', 'b'])
			await writeFile(
				join(native, 'todos', `${name}.md`),
				`---\ntitle: ${name}\ndone: false\n---\n`,
			);
		await git(native, 'add', '--all');
		await git(native, 'commit', '--quiet', '-m', 'Two more');
		await git(native, 'push', '--quiet', 'origin', 'main');
		const theirs = await git(native, 'rev-parse', 'HEAD');

		// The second incoming file never lands, as a quit would leave it.
		const stopping: DirectoryPrimitives = {
			...nodeDirectoryPrimitives,
			async rename(from, to, expected) {
				if (to.endsWith('/todos/b.md')) throw new Error('quit partway');
				return nodeDirectoryPrimitives.rename(from, to, expected);
			},
		};
		const interrupted = expectOk(await open(root, { primitives: stopping }));
		const stopped = await interrupted.sync.run();
		expect(stopped.error).not.toBeNull();
		await interrupted.close();

		const reopened = expectOk(await open(root));
		expectOk(await reopened.sync.run());
		for (const name of ['a', 'b'])
			expect(
				await readFile(join(root, 'todos', `${name}.md`), 'utf8'),
			).toContain(`title: ${name}`);
		await git(root, 'merge-base', '--is-ancestor', theirs, 'HEAD');
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await git(root, 'fsck', '--strict');
		await reopened.close();
	});

	test('a save another window lands while Sync writes the same row wins over the remote, and the next Sync sends it', async () => {
		const project = await scratch('directory-folder-incoming-race-');
		const bare = await createBareRemote(project);
		const root = join(project, 'desktop');
		await git(project, 'init', '--quiet', '--initial-branch=main', root);
		await git(root, 'remote', 'add', 'origin', bare);
		// Another window, sharing no lock with this folder, saves the row
		// after Sync checked it and before Sync's write publishes.
		let racing: string | undefined;
		const raced: DirectoryPrimitives = {
			...nodeDirectoryPrimitives,
			async rename(from, to, expected) {
				if (racing !== undefined && to.endsWith('.md')) {
					await writeFile(to, racing);
					racing = undefined;
				}
				return nodeDirectoryPrimitives.rename(from, to, expected);
			},
		};
		const folder = expectOk(await open(root, { primitives: raced }));
		const created = await addTodo(folder, 'Shared');
		expectOk(await folder.sync.run());

		// Another checkout renames the todo and pushes.
		const native = join(project, 'native');
		await git(project, 'clone', '--quiet', bare, native);
		const nativePath = join(native, created.path);
		await writeFile(
			nativePath,
			(await readFile(nativePath, 'utf8')).replace('Shared', 'Remote'),
		);
		await git(native, 'commit', '--quiet', '-am', 'Rename remotely');
		await git(native, 'push', '--quiet', 'origin', 'main');

		const theirs = '---\ntitle: Other window\ndone: false\n---\n';
		racing = theirs;
		// Sync merges the save in, the save winning the title both changed,
		// and says the folder changed since the version it published.
		const first = expectOk(await folder.sync.run());
		expect(first).toMatchObject({ kind: 'saved', changedSince: true });
		expect(await readFile(join(root, created.path), 'utf8')).toBe(theirs);

		const next = expectOk(await folder.sync.run());
		expect(next.kind).toBe('synced');
		expect(await readFile(join(root, created.path), 'utf8')).toBe(theirs);
		expect(await git(bare, 'show', `main:${created.path}`)).toContain(
			'title: Other window',
		);
		await folder.close();
	});

	test('saves a version with a message and reads its log with Git', async () => {
		const { root } = await nativeRepository('directory-folder-version-');
		const folder = expectOk(await open(root));
		await addTodo(folder, 'Versioned');
		expect((await folder.git.commit({ message: 'Add one todo' })).status).toBe(
			'committed',
		);
		expect(await git(root, 'log', '--format=%s', '-1')).toBe('Add one todo');
		const log = expectOk(await folder.git.log(5));
		expect(log[0]?.message.trim()).toBe('Add one todo');
		await git(root, 'fsck', '--strict');
		await folder.close();
	});

	test('syncs both ways with a native checkout through a real remote', async () => {
		const project = await scratch('directory-folder-sync-');
		const bare = await createBareRemote(project);

		const root = join(project, 'desktop');
		await git(project, 'init', '--quiet', '--initial-branch=main', root);
		await git(root, 'remote', 'add', 'origin', bare);
		const folder = expectOk(await open(root));
		const created = await addTodo(folder, 'Synced');
		expectOk(await folder.sync.run());
		expect(await git(bare, 'log', '--format=%s', '-1', 'main')).not.toBe('');

		// A native checkout edits the same todo and pushes.
		const native = join(project, 'native');
		await git(project, 'clone', '--quiet', bare, native);
		const nativePath = join(native, created.path);
		const nativeText = await readFile(nativePath, 'utf8');
		await writeFile(
			nativePath,
			nativeText.replace('done: false', 'done: true'),
		);
		await git(native, 'commit', '--quiet', '-am', 'Done natively');
		await git(native, 'push', '--quiet', 'origin', 'main');

		expectOk(await folder.sync.run());
		expect(await readFile(join(root, created.path), 'utf8')).toContain(
			'done: true',
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await git(root, 'fsck', '--strict');
		await folder.close();
	});

	test("connects through Git's own configuration: the remote is origin, and the first sync sends the folder", async () => {
		const project = await scratch('directory-folder-connect-');
		const bare = await createBareRemote(project);
		const root = join(project, 'desktop');
		await git(project, 'init', '--quiet', '--initial-branch=main', root);
		const folder = expectOk(await open(root));
		expect(folder.git.snapshot.remote).toBeUndefined();
		await addTodo(folder, 'Connected');
		const synced = expectOk(await folder.sync.connect(bare));
		expect(synced.kind).toBe('synced');
		expect(await git(root, 'config', '--get', 'remote.origin.url')).toBe(bare);
		expect(folder.git.snapshot.remote).toEqual({ url: bare, branch: 'main' });
		expect(await git(bare, 'rev-parse', 'main')).toBe(
			await git(root, 'rev-parse', 'main'),
		);
		await folder.close();
	});
});
