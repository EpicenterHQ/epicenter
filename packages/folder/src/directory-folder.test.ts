/**
 * The folder over an ordinary directory: files through the browser folder's
 * storage over directory primitives, history through real Git. Here the
 * primitives are `node:fs` and Git is the system `git`, as in the
 * `epicenter` CLI that runs a desktop page's history. Every check
 * reads the result with native Git, since another Git program shares the
 * repository.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { openDirectoryFolder } from './directory-adapter.js';
import {
	type DirectoryPrimitives,
	directoryHandle,
	SCRATCH_DIRECTORY,
} from './directory-handle.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { nativeHistory } from './git/native-history.js';
import { createGitRunner } from './git/native-host.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	scratch,
} from './git-http.test-support.js';
import { mustRow } from './row-write.test-support.js';

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const author = { name: 'Todos', email: 'todos@localhost' };

/**
 * Every file change these folders make, as a path below the root with Git's
 * object names and staging names reduced to their kind. `page_files.rs`
 * tests every recorded path; the desktop shell makes the file changes of a
 * page, and the `epicenter` CLI those of its history (ADR-0559).
 */
const FILE_CHANGES = join(
	import.meta.dir,
	'../../tauri-plugin-epicenter-folder/fixtures/page-file-changes.json',
);
const changed = new Set<string>();

function changeOf(root: string, path: string): string {
	return path
		.slice(root.length + 1)
		.replace(/^\.git\/objects\/[0-9a-f]{2}(?=\/|$)/, '.git/objects/ab')
		.replace(/^\.git\/objects\/ab\/[0-9a-f]{38}/, '.git/objects/ab/<object>')
		.replace(/\.tmp-[^/]+$/, '.tmp-<n>')
		.replace(
			/^\.git\/epicenter\/scratch\/[^/]+$/,
			'.git/epicenter/scratch/<staged>',
		)
		.replace(/^todos\/[^/]+\.md$/, 'todos/<stem>.md');
}

function recording(
	root: string,
	files: DirectoryPrimitives,
): DirectoryPrimitives {
	const note = (path: string) => {
		if (path.startsWith(`${root}/`)) changed.add(changeOf(root, path));
	};
	return {
		...files,
		async writeFile(path, bytes, options) {
			note(path);
			return files.writeFile(path, bytes, options);
		},
		async rename(from, to, expected) {
			note(from);
			note(to);
			return files.rename(from, to, expected);
		},
		async remove(path, options) {
			note(path);
			return files.remove(path, options);
		},
		async mkdir(path) {
			note(path);
			return files.mkdir(path);
		},
	};
}

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
	if (process.env.FOLDER_WRITE_GIT_CALLS === '1') {
		writeFileSync(
			FILE_CHANGES,
			`${JSON.stringify([...changed].sort(), null, '\t')}\n`,
		);
	} else {
		const knownChanges = new Set<string>(
			existsSync(FILE_CHANGES)
				? (JSON.parse(readFileSync(FILE_CHANGES, 'utf8')) as string[])
				: [],
		);
		const unlisted = [...changed].filter((path) => !knownChanges.has(path));
		if (unlisted.length > 0)
			throw new Error(
				`The folder engine changes paths the desktop contract does not list; run FOLDER_WRITE_GIT_CALLS=1 bun test src/directory-folder.test.ts and update page_files.rs if its tests fail:\n${unlisted.join('\n')}`,
			);
	}
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
	const primitives = options.primitives ?? nodeDirectoryPrimitives;
	// Only the page's file changes are recorded: on the desktop the history
	// runs in the `epicenter` CLI, which the shell does not hold to them.
	const files = recording(root, primitives);
	const system = createGitRunner(root);
	const run: typeof system = async (args, runOptions) => {
		await options.beforeGit?.(args);
		return system(args, runOptions);
	};
	return openDirectoryFolder({
		definition,
		root: directoryHandle(files, root),
		rootPath: root,
		files,
		history: nativeHistory({
			rootPath: root,
			host: { run, files: primitives },
			author,
		}),
	});
}

const HOUR = 60 * 60 * 1000;

/** A staged file's name as another process's handle makes it, `offset` from now. */
const stagedName = (offset: number) =>
	`${(Date.now() + offset).toString(36)}-${'0'.repeat(32)}-0`;

/** A staged file's name as handles made it before each had an engine id. */
const earlierStagedName = (offset: number) =>
	`${(Date.now() + offset).toString(36)}-0-a1b2c3d4`;

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

	test('a write another writer overtakes after its check merges; a create or a remove is refused where it publishes', async () => {
		const root = await scratch('directory-folder-overtaken-');
		const sha256 = (text: string) => hashBytes(new TextEncoder().encode(text));
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
		const made = await folder.files.create('todos/a.md', 'mine\n');
		expect(made.error?.name).toBe('Exists');
		expect(await readFile(note, 'utf8')).toBe('theirs\n');

		const captured = expectOk(await folder.files.read('todos/a.md'));
		overtaken.set(note, 'theirs again\n');
		const removed = await folder.files.remove(captured);
		expect(removed.error).toMatchObject({
			name: 'Conflict',
			expectedSha256: captured.sha256,
			actualSha256: await sha256('theirs again\n'),
		});
		expect(await readFile(note, 'utf8')).toBe('theirs again\n');

		// A save merges with whatever is there, and wins the lines both changed.
		const again = expectOk(await folder.files.read('todos/a.md'));
		overtaken.set(note, 'theirs once more\n');
		const mine = expectOk(await folder.files.save(again, 'mine\n'));
		expect(mine.merged).toBe(true);
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
		// So is one named as handles named them before each had an engine id.
		await writeFile(
			join(root, SCRATCH_DIRECTORY, earlierStagedName(-2 * HOUR)),
			'x',
		);
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
		const earlierFresh = earlierStagedName(0);
		for (const name of [fresh, old, earlierFresh, 'left-behind'])
			await writeFile(join(root, SCRATCH_DIRECTORY, name), 'x');
		const folder = expectOk(await open(root));
		expect((await readdir(join(root, SCRATCH_DIRECTORY))).sort()).toEqual(
			[fresh, earlierFresh, 'left-behind'].sort(),
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
