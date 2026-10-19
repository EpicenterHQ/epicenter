/**
 * A directory's history over real Git: the engine the `epicenter` CLI runs
 * (`runHistory`), with files saved through the one write Sync publishes
 * with. Here the primitives are `node:fs` and Git is the system `git`.
 * Every check reads the result with native Git, since another Git program
 * shares the repository.
 *
 * Key behaviors:
 * - Saving writes real files and creates no repository; the first commit
 *   does, and native Git reads it cleanly
 * - An existing repository, its author, a packed branch, and a commit native
 *   Git makes meanwhile are continued, never forked; its configuration is
 *   left as the person set it
 * - A held index, an executable, an attribute file naming a filter, a
 *   branch other than `main`, or a merge another Git program began is
 *   reported, never silently rewritten; a branch that moves twice is never
 *   forced
 * - A save makes no commit; the next commit records external bytes with it
 * - With `core.autocrlf`, every commit and Sync records the bytes on disk
 * - A write merges with what another program landed, even after its check
 * - Two handles of one directory share one repository and one linear history
 * - An incoming update cut off partway is finished by the next Sync, and a
 *   save racing Sync's publish wins and is sent next; Sync stops where a
 *   remote name is held here under another spelling
 * - Sync connects through Git's own `origin`, and syncs both ways with a
 *   native checkout
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
import { expectErr, expectOk } from 'wellcrafted/testing';
import { SCRATCH_DIRECTORY } from './boundary.js';
import {
	type DirectoryHistory,
	openDirectoryHistory,
	rawDirectoryFolder,
} from './directory-history.test-support.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import type { DirectoryPrimitives } from './directory-primitives.js';
import { createHistory } from './git/history.js';
import { createNativeGitBackend } from './git/native-backend.js';
import { createGitRunner } from './git/native-host.js';
import { NEUTRAL_ATTRIBUTES } from './git/neutral-attributes.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	scratch,
} from './git-http.test-support.js';

const author = { name: 'Todos', email: 'todos@localhost' };

const originalEnv = { ...process.env };

beforeAll(() => {
	// The history's own `git` and the checks here must not pick up the
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

function open(
	root: string,
	options: {
		primitives?: DirectoryPrimitives;
		/** Runs before each `git` command this handle runs. */
		beforeGit?: (args: readonly string[]) => Promise<void>;
	} = {},
) {
	return openDirectoryHistory({ root, git: { author }, ...options });
}

/** A todo row's text. */
const todo = (title: string, done = false) =>
	`---\ntitle: ${title}\ndone: ${done}\n---\n`;

let todos = 0;

/** Save a new todo row through the one write, at a path no other test uses. */
async function addTodo(folder: DirectoryHistory, title: string) {
	const path = `todos/t${todos++}.md`;
	const text = todo(title);
	expectOk(await folder.write(path, null, text));
	return { path, text };
}

/** A repository native Git made, with one committed file. */
async function nativeRepository(prefix: string) {
	const root = await scratch(prefix);
	await git(root, 'init', '--quiet', '--initial-branch=main');
	await writeFile(join(root, 'notes.txt'), 'kept\n');
	await git(root, 'add', 'notes.txt');
	await git(root, 'commit', '--quiet', '-m', 'Native start');
	return { root, start: await git(root, 'rev-parse', 'HEAD') };
}

describe('a directory history', () => {
	test('writes real files and a repository native Git reads cleanly', async () => {
		const root = await scratch('directory-history-');
		const folder = await open(root);
		// Opening wrote nothing, and created no repository.
		expect(existsSync(join(root, 'todos'))).toBe(false);
		expect(existsSync(join(root, '.git'))).toBe(false);
		const created = await addTodo(folder, 'Buy milk');
		expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
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
			'directory-history-existing-',
		);
		await git(root, 'config', 'user.name', 'Braden');
		await git(root, 'config', 'user.email', 'braden@example.test');

		const folder = await open(root);
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

	test("a new directory's first commit is made as the person's global Git identity", async () => {
		const root = await scratch('directory-history-identity-');
		const global = join(
			await scratch('directory-history-global-'),
			'gitconfig',
		);
		await writeFile(
			global,
			'[user]\n\tname = Braden\n\temail = braden@example.test\n',
		);
		process.env.GIT_CONFIG_GLOBAL = global;
		try {
			const folder = await open(root);
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
		const { root, start } = await nativeRepository('directory-history-packed-');
		await git(root, 'pack-refs', '--all');
		await git(root, 'gc', '--quiet');
		const folder = await open(root);
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

	test('a commit native Git makes while the history is open is the next parent', async () => {
		const { root } = await nativeRepository('directory-history-concurrent-');
		const folder = await open(root);
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
		const { root, start } = await nativeRepository('directory-history-lock-');
		const folder = await open(root);
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
		const { root } = await nativeRepository('directory-history-config-');
		await git(root, 'remote', 'add', 'origin', 'https://example.test/r.git');
		await git(
			root,
			'config',
			'--add',
			'remote.origin.fetch',
			'+refs/pull/*/head:refs/remotes/origin/pr/*',
		);
		const before = await readFile(join(root, '.git', 'config'), 'utf8');
		const folder = await open(root);
		await addTodo(folder, 'Config untouched');
		expect((await folder.git.commit()).status).toBe('committed');
		expect(await readFile(join(root, '.git', 'config'), 'utf8')).toBe(before);
		await folder.close();
	});

	test('a repository that tracks an executable refuses the commit and names it', async () => {
		const root = await scratch('directory-history-modes-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		await writeFile(join(root, 'run.sh'), '#!/bin/sh\n');
		await chmod(join(root, 'run.sh'), 0o755);
		await git(root, 'add', 'run.sh');
		await git(root, 'commit', '--quiet', '-m', 'Executable');
		const head = await git(root, 'rev-parse', 'HEAD');

		const folder = await open(root);
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
		const project = await scratch('directory-history-autocrlf-');
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
			const folder = await open(root, {
				beforeGit: async (args) => void ran.push(args),
			});
			const created = await addTodo(folder, 'Line feeds');
			// The first commit creates the repository.
			expect((await folder.git.commit()).status).toBe('committed');
			expect(await readFile(join(root, '.git/info/attributes'), 'utf8')).toBe(
				`${NEUTRAL_ATTRIBUTES}\n`,
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

	test('an attribute file that names a filter and governs a recorded file, ignored or not, refuses the commit; line-ending attributes commit the bytes on disk', async () => {
		const { root, start } = await nativeRepository('directory-history-filter-');
		await writeFile(join(root, '.gitattributes'), '*.md text eol=crlf\n');
		const folder = await open(root);
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

		// An ignored attribute file over nothing recorded governs nothing a
		// commit carries.
		await writeFile(join(root, '.gitattributes'), '*.md text eol=crlf\n');
		await writeFile(join(root, '.gitignore'), 'local/\nnode_modules/\n');
		await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
		await writeFile(
			join(root, 'node_modules/pkg/.gitattributes'),
			'* filter=lfs\n',
		);
		await writeFile(join(root, 'node_modules/pkg/index.js'), 'x\n');
		const unaffected = await folder.git.commit();
		expect(unaffected.status).toBe('committed');
		const next = await git(root, 'rev-parse', 'HEAD');

		// One in an ignored directory that holds a recorded file refuses.
		await mkdir(join(root, 'local'));
		await writeFile(join(root, 'local/kept.md'), 'kept\n');
		await git(root, 'add', '--force', 'local/kept.md');
		await writeFile(join(root, 'local/.gitattributes'), '* filter=lfs\n');
		const ignored = await folder.git.commit();
		expect(ignored.status).toBe('blocked');
		expect(JSON.stringify(ignored)).toContain(
			'local/.gitattributes line 1 (* filter=lfs) names a Git filter',
		);
		expect(await git(root, 'rev-parse', 'HEAD')).toBe(next);
		await folder.close();
	});

	test('a write merges with a file another program changed', async () => {
		const root = await scratch('directory-history-guard-');
		const folder = await open(root);
		const created = await addTodo(folder, 'Mine');
		const path = join(root, created.path);
		await writeFile(path, todo('Mine', true));
		expectOk(
			await folder.write(created.path, created.text, todo('Mine, edited')),
		);
		expect(await readFile(path, 'utf8')).toBe(todo('Mine, edited', true));
		await folder.close();
	});

	test('a write another writer overtakes after its check merges; a create joins the file made meanwhile, and a delete reads again and gives way to the edit', async () => {
		const root = await scratch('directory-history-overtaken-');
		// Another writer, sharing no lock with this history, lands these bytes
		// on a path after this one checked it and before it publishes.
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
		const folder = await open(root, { primitives: racing });

		const created = await addTodo(folder, 'Mine');
		const path = join(root, created.path);
		overtaken.set(path, todo('Theirs'));
		expectOk(
			await folder.write(created.path, created.text, todo('Mine, edited')),
		);
		expect(await readFile(path, 'utf8')).toContain('title: Mine, edited');

		const note = join(root, 'todos/a.md');
		overtaken.set(note, 'theirs\n');
		// A create onto a file made meanwhile merges as an addition on both
		// sides.
		expectOk(await folder.write('todos/a.md', null, 'mine\n'));
		expect(await readFile(note, 'utf8')).toBe('theirs\nmine\n');

		// A delete reads again, and never erases an edit it did not see.
		overtaken.set(note, 'theirs again\n');
		expectOk(await folder.write('todos/a.md', 'theirs\nmine\n', null));
		expect(await readFile(note, 'utf8')).toBe('theirs again\n');

		// A write merges with whatever is there, and wins the lines both changed.
		expectOk(await folder.write('todos/a.md', 'theirs again\n', 'base\n'));
		overtaken.set(note, 'theirs once more\n');
		expectOk(await folder.write('todos/a.md', 'base\n', 'mine\n'));
		expect(await readFile(note, 'utf8')).toBe('mine\n');
		expect(await readdir(join(root, SCRATCH_DIRECTORY))).toEqual([]);
		await folder.close();
	});

	test('a write that stops before it lands leaves nothing at its path', async () => {
		const root = await scratch('directory-history-interrupted-');
		// The rename that publishes a todo is lost, as a quit would lose it.
		const failing: DirectoryPrimitives = {
			...nodeDirectoryPrimitives,
			async rename(from, to, expected) {
				if (to.includes('/todos/')) throw new Error('quit before the rename');
				return nodeDirectoryPrimitives.rename(from, to, expected);
			},
		};
		const interrupted = await open(root, { primitives: failing });
		const refused = await interrupted.write(
			'todos/never.md',
			null,
			todo('Never landed'),
		);
		expect(refused.error).not.toBeNull();
		// Neither an empty file nor a partial one is at the path.
		const listed = await readdir(join(root, 'todos')).catch(() => []);
		expect(listed.filter((name) => name.endsWith('.md'))).toEqual([]);
		await interrupted.close();
	});

	test('two handles opening a new directory at once share one repository', async () => {
		const root = await scratch('directory-history-race-');
		const [a, b] = await Promise.all([open(root), open(root)]);
		await addTodo(a, 'From one window');
		expect((await b.git.commit()).status).toBe('committed');
		expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await git(root, 'fsck', '--strict');
		await a.close();
		await b.close();
	});

	test('a commit whose branch another handle moved retries from a fresh capture', async () => {
		const root = await scratch('directory-history-commit-race-');
		const a = await open(root);
		await addTodo(a, 'First');
		expect((await a.git.commit()).status).toBe('committed');
		// Handle A commits after B captured and before B moves the branch,
		// then saves once more: B's retry must record that save.
		let interleave = true;
		const b = await open(root, {
			async beforeGit(args) {
				if (!interleave || args[0] !== 'update-ref') return;
				interleave = false;
				await addTodo(a, 'Committed by A');
				expect((await a.git.commit()).status).toBe('committed');
				await addTodo(a, 'Saved after A committed');
			},
		});
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

	test('two handles that commit at once both land on one linear history', async () => {
		const root = await scratch('directory-history-commits-');
		const a = await open(root);
		const b = await open(root);
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
		const project = await scratch('directory-history-incoming-');
		const bare = await createBareRemote(project);
		const root = join(project, 'desktop');
		await git(project, 'init', '--quiet', '--initial-branch=main', root);
		await git(root, 'remote', 'add', 'origin', bare);
		const first = await open(root);
		await addTodo(first, 'Shared');
		expectOk(await first.sync.run());
		await first.close();

		// Another checkout adds two todos and pushes.
		const native = join(project, 'native');
		await git(project, 'clone', '--quiet', bare, native);
		for (const name of ['a', 'b'])
			await writeFile(join(native, 'todos', `${name}.md`), todo(name));
		await git(native, 'add', '--all');
		await git(native, 'commit', '--quiet', '-m', 'Two more');
		await git(native, 'push', '--quiet', 'origin', 'main');
		// The second incoming file never lands, as a quit would leave it.
		const stopping: DirectoryPrimitives = {
			...nodeDirectoryPrimitives,
			async rename(from, to, expected) {
				if (to.endsWith('/todos/b.md')) throw new Error('quit partway');
				return nodeDirectoryPrimitives.rename(from, to, expected);
			},
		};
		const interrupted = await open(root, { primitives: stopping });
		const stopped = await interrupted.sync.run();
		expect(stopped.error).not.toBeNull();
		await interrupted.close();
		// The remote changes a file that already landed before the interruption.
		// Recovery must finish that publication before comparing new edits.
		await writeFile(join(native, 'todos/a.md'), todo('New remote title'));
		await git(native, 'add', '--all');
		await git(native, 'commit', '--quiet', '-m', 'Edit landed file');
		await git(native, 'push', '--quiet', 'origin', 'main');
		const latest = await git(native, 'rev-parse', 'HEAD');

		const reopened = await open(root);
		expectOk(await reopened.sync.run());
		expect(await readFile(join(root, 'todos/a.md'), 'utf8')).toContain(
			'title: New remote title',
		);
		expect(await readFile(join(root, 'todos/b.md'), 'utf8')).toContain(
			'title: b',
		);
		await git(root, 'merge-base', '--is-ancestor', latest, 'HEAD');
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await git(root, 'fsck', '--strict');
		await reopened.close();
	});

	test('a save another program lands while Sync writes the same row wins over the remote, and the next Sync sends it', async () => {
		const project = await scratch('directory-history-incoming-race-');
		const bare = await createBareRemote(project);
		const root = join(project, 'desktop');
		await git(project, 'init', '--quiet', '--initial-branch=main', root);
		await git(root, 'remote', 'add', 'origin', bare);
		// Another program, sharing no lock with this history, saves the row
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
		const folder = await open(root, { primitives: raced });
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

		const theirs = todo('Other window');
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
		const { root } = await nativeRepository('directory-history-version-');
		const folder = await open(root);
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
		const project = await scratch('directory-history-sync-');
		const bare = await createBareRemote(project);

		const root = join(project, 'desktop');
		await git(project, 'init', '--quiet', '--initial-branch=main', root);
		await git(root, 'remote', 'add', 'origin', bare);
		const folder = await open(root);
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

	test('an existing non-main HEAD refuses history changes while file saves remain available', async () => {
		const root = await scratch('directory-history-branch-');
		await git(root, 'init', '--quiet', '--initial-branch=backup');
		await writeFile(join(root, 'legacy.txt'), 'previous history');
		await git(root, 'add', 'legacy.txt');
		await git(root, 'commit', '--quiet', '-m', 'Previous history');
		const previous = await git(root, 'rev-parse', 'HEAD');
		const folder = await open(root);
		try {
			expectOk(await folder.write('saved.txt', null, 'saved'));
			expect(await folder.git.commit()).toMatchObject({
				status: 'blocked',
				reason: 'HEAD is not on main',
			});
			expect(await git(root, 'rev-parse', 'HEAD')).toBe(previous);
			expect(
				await git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads'),
			).toBe('refs/heads/backup');
			expect(await readFile(join(root, 'saved.txt'), 'utf8')).toBe('saved');
		} finally {
			await folder.close();
		}
	});

	test('a save makes no commit; the next commit checkpoints external bytes with it, and keeps the native index consistent', async () => {
		const root = await scratch('directory-history-checkpoint-');
		const folder = await open(root);
		try {
			await writeFile(join(root, 'external.md'), 'external');
			expectOk(await folder.write('saved.md', null, 'saved'));
			expect(folder.git.snapshot.lastCommit).toBeUndefined();
			expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
			// Saving creates no repository; the first commit does.
			expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
			expect((await folder.git.commit()).status).toBe('committed');
			expect(await git(root, 'show', 'HEAD:external.md')).toBe('external');
			expect(await git(root, 'show', 'HEAD:saved.md')).toBe('saved');
			expect(await git(root, 'status', '--porcelain')).toBe('');

			// An edit another program makes is merged by the next save, and the
			// commit after it is recorded through Git's own index.
			await writeFile(join(root, 'saved.md'), 'saved\nexternal line\n');
			expectOk(await folder.write('saved.md', 'saved', 'saved\nmine\n'));
			expect(await git(root, 'status', '--porcelain')).toBe('M saved.md');
			expect((await folder.git.commit()).status).toBe('committed');
			expect(await git(root, 'log', '-1', '--format=%s')).toBe(
				'Update saved.md',
			);
			expect(await git(root, 'status', '--porcelain')).toBe('');
		} finally {
			await folder.close();
		}
	});

	test("Sync stops where a remote file's name is held here under another spelling", async () => {
		const project = await scratch('directory-history-case-sync-');
		const bare = await createBareRemote(project);
		const peer = join(project, 'peer');
		await git(project, 'clone', '--quiet', bare, peer);
		await writeFile(join(peer, 'keep.md'), 'keep\n');
		await git(peer, 'add', '--all');
		await git(peer, 'commit', '--quiet', '-m', 'Start');
		await git(peer, 'push', '--quiet', 'origin', 'HEAD:main');
		const root = join(project, 'local');
		await git(project, 'clone', '--quiet', bare, root);
		const folder = await open(root);
		expect(expectOk(await folder.sync.run()).kind).toBe('synced');
		// An ignored local file, and the remote adding its other spelling.
		await writeFile(join(root, '.git/info/exclude'), 'notes.md\n');
		await writeFile(join(root, 'notes.md'), 'mine, ignored\n');
		await writeFile(join(peer, 'Notes.md'), 'theirs\n');
		await git(peer, 'add', '--all');
		await git(peer, 'commit', '--quiet', '-m', 'Notes');
		await git(peer, 'push', '--quiet', 'origin', 'HEAD:main');
		const head = await git(root, 'rev-parse', 'HEAD');
		// Names compare folded on every disk, so a case-sensitive one stops
		// too: the directory must open on a case-insensitive one.
		const synced = await folder.sync.run();
		expect(synced.error?.name).toBe('Blocked');
		expect(synced.error?.message).toContain("'Notes.md'");
		expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
		expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(
			'mine, ignored\n',
		);
		await folder.close();
	});

	test('a branch that moves again under the retry refuses the checkpoint; the branch is never forced', async () => {
		const { root, boundary } = await rawDirectoryFolder(
			'directory-history-cas-',
		);
		await git(root, 'init', '--quiet', '--initial-branch=main');
		const backend = await createNativeGitBackend({
			root,
			branch: 'main',
			host: { run: createGitRunner(root), files: nodeDirectoryPrimitives },
		});
		const history = createHistory({
			backend: {
				...backend,
				async casBranch(expected, next) {
					await git(
						root,
						'commit',
						'--quiet',
						'--allow-empty',
						'-m',
						'Competitor',
					);
					return backend.casBranch(expected, next);
				},
			},
			boundary,
			author,
		});
		await writeFile(join(root, 'a.txt'), 'a');
		const outcome = await history.commit();
		expect(outcome.status).toBe('branchMoved');
		// The first move was retried once; the second is reported.
		expect(await git(root, 'log', '--format=%s')).toBe(
			'Competitor\nCompetitor',
		);
		if (outcome.status === 'branchMoved') {
			// The candidate exists as an unreachable object; it was not published.
			expect(await git(root, 'cat-file', '-t', outcome.candidate)).toBe(
				'commit',
			);
			expect(outcome.actual).toBe(await git(root, 'rev-parse', 'HEAD'));
		}
		await history.close();
	});

	test('a merge another Git program began blocks commits and Sync until Git finishes it', async () => {
		const root = await scratch('directory-history-merge-head-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		const folder = await open(root);
		await folder.write('a.md', null, 'one\n');
		expect((await folder.git.commit()).status).toBe('committed');
		const head = await git(root, 'rev-parse', 'main');
		await writeFile(join(root, '.git/MERGE_HEAD'), `${head}\n`);
		await writeFile(join(root, 'a.md'), 'two\n');

		const commit = await folder.git.commit();
		expect(commit).toMatchObject({ status: 'blocked' });
		if (commit.status === 'blocked')
			expect(commit.reason).toContain(
				'a Git operation is in progress (MERGE_HEAD)',
			);
		await git(root, 'remote', 'add', 'origin', join(root, 'none.git'));
		expect(expectErr(await folder.sync.run()).name).toBe('Checkpoint');
		expect(await git(root, 'rev-parse', 'main')).toBe(head);
		await folder.close();
	});

	test("connects through Git's own configuration: the remote is origin, and the first sync sends the directory", async () => {
		const project = await scratch('directory-history-connect-');
		const bare = await createBareRemote(project);
		const root = join(project, 'desktop');
		await git(project, 'init', '--quiet', '--initial-branch=main', root);
		const folder = await open(root);
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
