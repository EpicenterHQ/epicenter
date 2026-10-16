/**
 * What Sync writes into a browser folder in the origin private file system
 * (ADR-0576): the files, holding the folder's save lock, then the index and
 * the branch. Each file lands whole: a replaced file when its stream closes,
 * a new one moved into place from `.git/epicenter/scratch`. A publish cut
 * off partway leaves each file at its old bytes or its new ones, ordinary
 * changes that the next Sync records and merges to the same files
 * (ADR-0545).
 *
 * A publish is interrupted by an injected failure: a write that throws before
 * its stream closed, a close that throws, a close whose reply was lost (the
 * bytes landed), or a move that fails. These run over the in-memory OPFS
 * stand-in; the remote is a bare repository served by `git http-backend`.
 *
 * Key behaviors:
 * - A fast-forward or a merge cut off at a new file, a replaced file, the
 *   index, or the branch is finished by the next Sync, with local work kept,
 *   and lands on the remote's tree
 * - A folder reopened over a cut-off publish converges on its next Sync
 * - Directories turn into files and files into directories; directories the
 *   removals emptied are pruned, and a directory something else keeps stays
 * - A file this folder never committed where Sync writes a file or needs a
 *   directory refuses the publish before anything changes; a file added here
 *   where the remote added a directory stands beside it as `~local`
 * - An empty first-commit ref, and a repository whose creation stopped before
 *   `HEAD`, keep working
 * - A `local` pattern another device's `epicenter.json` brings in keeps its
 *   files out of the next commit in the same open folder; an `epicenter.json`
 *   that does not read refuses the commit
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder, type Folder, openFolder } from '../browser.js';
import { formatDeclaration } from '../declaration.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	gitHttpFetch,
	scratch,
} from '../git-http.test-support.js';
import {
	type MemoryOpfs,
	memoryOpfs,
	opfsEnvironment,
} from '../opfs.test-support.js';
import {
	createOpfsStorage,
	ensureDirectory,
	presentFolder,
} from '../opfs-store.js';
import { overwrite } from '../put.test-support.js';
import { useWebLocks } from '../web-locks.test-support.js';
import { createStoredGitBackend } from './browser-backend.js';
import { createHistory } from './history.js';
import { createOpfsGitStore } from './opfs-git.js';

useWebLocks();

const author = { name: 'Merger', email: 'merger@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ROOT = 'merge';
const FILES_LOCK = 'epicenter-folder:merge:files';
const GIT_LOCK = 'epicenter-folder:merge:git';
const REMOTE_URL = 'http://git.test/remote.git';
const definition = defineFolder({ kv: {}, tables: {} });
const discovery = formatDeclaration(definition);

type Tree = Record<string, string>;
type Opened = Folder<typeof definition>;

const opened: { close(): Promise<void> }[] = [];
const scratches: string[] = [];
afterEach(async () => {
	for (const item of opened.splice(0)) await item.close();
	for (const root of scratches.splice(0))
		await rm(root, { recursive: true, force: true });
});

/** A raw folder where the opener looks for it, with history over it. */
async function folderAt(opfs = memoryOpfs()) {
	const environment = opfsEnvironment(opfs);
	const root = expectOk(
		await ensureDirectory(await environment.getDirectory(), ROOT),
	);
	const backend = await createStoredGitBackend({
		store: createOpfsGitStore({ folder: presentFolder(root) }),
		locks: environment.locks,
		lockName: GIT_LOCK,
		branch: 'main',
	});
	const boundary = createOpfsStorage({
		folder: presentFolder(root),
		locks: environment.locks,
		filesLock: FILES_LOCK,
		landed: () => {},
	});
	const history = createHistory({ backend, boundary, author });
	opened.push(history);

	async function write(path: string, value: string) {
		await overwrite(boundary, path, value);
	}
	return { opfs, history, write };
}

/** Make the first write to a path ending with `suffix` throw before it publishes. */
function failWrite(opfs: MemoryOpfs, suffix: string) {
	let failed = false;
	opfs.faults.write = (path) => {
		if (failed || !path.endsWith(suffix)) return undefined;
		failed = true;
		return 'fail';
	};
}

/** Make the first close at a path ending with `suffix` lose its reply: the bytes landed. */
function loseClose(opfs: MemoryOpfs, suffix: string) {
	let lost = false;
	opfs.faults.close = (path) => {
		if (lost || !path.endsWith(suffix)) return undefined;
		lost = true;
		return 'lost';
	};
}

function clearFaults(opfs: MemoryOpfs) {
	opfs.faults.write = undefined;
	opfs.faults.close = undefined;
	opfs.faults.remove = undefined;
	opfs.faults.move = undefined;
}

function folderFiles(opfs: MemoryOpfs) {
	return Object.fromEntries(
		[...opfs.files(ROOT)]
			.filter(([path]) => !path.startsWith('.git/'))
			.map(([path, bytes]) => [path, decoder.decode(bytes)])
			.sort(([a], [b]) => (a! < b! ? -1 : 1)),
	);
}

const stored = (opfs: MemoryOpfs, path: string) => opfs.files(ROOT).get(path);

/**
 * A bare remote over HTTP holding `tree`, another clone that commits to it
 * as a second device would, and a browser folder that adopted it by Sync.
 */
async function synced(tree: Tree, opfs = memoryOpfs()) {
	const root = await scratch('opfs-incoming-');
	scratches.push(root);
	const bare = await createBareRemote(root);
	const other = join(root, 'other');
	await git(root, 'clone', '--quiet', bare, other);
	/** Commit `changes` on the other clone and push; `null` removes a file. */
	async function push(changes: Record<string, string | null>) {
		await git(other, 'pull', '--quiet', '--ff-only', 'origin', 'main');
		for (const [path, text] of Object.entries(changes))
			if (text === null) await git(other, 'rm', '--quiet', path);
			else {
				await mkdir(dirname(join(other, path)), { recursive: true });
				await writeFile(join(other, path), text);
				await git(other, 'add', '--force', path);
			}
		await git(other, 'commit', '--quiet', '-m', 'Other device');
		await git(other, 'push', '--quiet', 'origin', 'HEAD:main');
	}
	await git(other, 'checkout', '--quiet', '-b', 'main');
	for (const [path, text] of Object.entries({
		'epicenter.json': discovery,
		...tree,
	})) {
		await mkdir(dirname(join(other, path)), { recursive: true });
		await writeFile(join(other, path), text);
		await git(other, 'add', path);
	}
	await git(other, 'commit', '--quiet', '-m', 'First');
	await git(other, 'push', '--quiet', 'origin', 'main');

	const httpFetch = await gitHttpFetch(root);
	const open = async () => {
		const folder = expectOk(
			await openFolder({
				id: ROOT,
				definition,
				browser: { author, httpFetch, opfs: opfsEnvironment(opfs) },
			}),
		);
		opened.push(folder);
		return folder;
	};
	const folder = await open();
	expectOk(await folder.sync.connect(REMOTE_URL));
	return { opfs, folder, bare, push, open };
}

async function changedPaths(folder: Opened) {
	return expectOk(await folder.git.status()).changes.map(({ path }) => path);
}

/** The remote branch's files, as another clone would check them out. */
async function remoteFiles(bare: string) {
	const paths = (await git(bare, 'ls-tree', '-r', '--name-only', 'main'))
		.split('\n')
		.filter((path) => path !== '');
	return Object.fromEntries(
		await Promise.all(
			paths.map(async (path) => {
				const show = Bun.spawn(['git', 'show', `main:${path}`], {
					cwd: bare,
					env: GIT_ENV,
					stdout: 'pipe',
				});
				return [path, await new Response(show.stdout).text()];
			}),
		),
	);
}

/** Where a publish is cut off. */
/** A new file's bytes, staged before they are moved into place. */
const staged = (path: string) =>
	path.includes(`${ROOT}/.git/epicenter/scratch/`);

/** Where a publish is cut off: each first matching step fails. */
const faults: [string, (opfs: MemoryOpfs) => void][] = [
	[
		"a new file's write",
		(opfs) => {
			let failed = false;
			opfs.faults.write = (path) => {
				if (failed || !staged(path)) return undefined;
				failed = true;
				return 'fail';
			};
		},
	],
	[
		"a new file's close",
		(opfs) => {
			let failed = false;
			opfs.faults.close = (path) => {
				if (failed || !staged(path)) return undefined;
				failed = true;
				return 'fail';
			};
		},
	],
	[
		"a new file's move into place",
		(opfs) => {
			opfs.faults.move = (path) =>
				path.endsWith(`${ROOT}/z.md`) ? 'fail' : undefined;
		},
	],
	['a replaced file', (opfs) => failWrite(opfs, `${ROOT}/a.md`)],
	[
		'a replaced file whose reply was lost',
		(opfs) => loseClose(opfs, `${ROOT}/a.md`),
	],
	['the index', (opfs) => failWrite(opfs, `${ROOT}/.git/index`)],
	['the branch', (opfs) => failWrite(opfs, `${ROOT}/.git/refs/heads/main`)],
	[
		'the branch whose reply was lost',
		(opfs) => loseClose(opfs, `${ROOT}/.git/refs/heads/main`),
	],
];

for (const [stage, fault] of faults)
	test(`a fast-forward cut off at ${stage} is finished by the next Sync, with local work kept`, async () => {
		const { opfs, folder, bare, push } = await synced({
			'a.md': '1',
			'gone.md': 'gone',
		});
		await push({ 'a.md': '2', 'gone.md': null, 'z.md': 'new' });

		fault(opfs);
		await folder.sync.run();
		clearFaults(opfs);
		// Removals go first, so the removal landed before any write failed.
		expect(stored(opfs, 'gone.md')).toBeUndefined();

		expectOk(await folder.files.create('notes.md', 'mine'));
		const outcome = expectOk(await folder.sync.run());
		expect(outcome.kind).toBe('synced');
		const expected = {
			'epicenter.json': discovery,
			'a.md': '2',
			'notes.md': 'mine',
			'z.md': 'new',
		};
		expect(folderFiles(opfs)).toEqual(expected);
		expect(await changedPaths(folder)).toEqual([]);
		expect(await remoteFiles(bare)).toEqual(expected);
	});

for (const [stage, fault] of faults)
	test(`a merge cut off at ${stage} is finished by the next Sync, with both sides' changes`, async () => {
		const { opfs, folder, bare, push } = await synced({
			'a.md': '1',
			'b.md': '1',
			'gone.md': 'gone',
			'shared.md': 'one\ntwo\nthree\n',
		});
		await push({
			'a.md': '2',
			'gone.md': null,
			'shared.md': 'ONE\ntwo\nthree\n',
			'z.md': 'new',
		});
		// A local commit the remote does not have makes Sync a merge.
		const b = expectOk(await folder.files.read('b.md'));
		expectOk(await folder.files.save(b, '2'));
		const shared = expectOk(await folder.files.read('shared.md'));
		expectOk(await folder.files.save(shared, 'one\ntwo\nTHREE\n'));
		// Recorded first, so the fault reaches Sync's publish, not its checkpoint.
		expect((await folder.git.commit()).status).toBe('committed');

		fault(opfs);
		await folder.sync.run();
		clearFaults(opfs);
		// The merge was pushed before any file here changed.
		const expected = {
			'epicenter.json': discovery,
			'a.md': '2',
			'b.md': '2',
			'shared.md': 'ONE\ntwo\nTHREE\n',
			'z.md': 'new',
		};
		expect(await remoteFiles(bare)).toEqual(expected);

		const outcome = expectOk(await folder.sync.run());
		expect(outcome.kind).toBe('synced');
		expect(folderFiles(opfs)).toEqual(expected);
		expect(await changedPaths(folder)).toEqual([]);
		expect(await remoteFiles(bare)).toEqual(expected);
	});

test('a folder reopened over a cut-off publish converges on its next Sync', async () => {
	const { opfs, folder, bare, push, open } = await synced({ 'a.md': '1' });
	await push({ 'a.md': '2', 'z.md': 'new' });
	opfs.faults.move = (path) =>
		path.endsWith(`${ROOT}/z.md`) ? 'fail' : undefined;
	expect((await folder.sync.run()).error).not.toBeNull();
	clearFaults(opfs);
	// Each file holds its old bytes or its new ones; nothing is empty.
	expect(folderFiles(opfs)).toEqual({
		'epicenter.json': discovery,
		'a.md': '2',
	});
	await folder.close();

	const reopened = await open();
	expectOk(await reopened.files.create('notes.md', 'mine'));
	expect(expectOk(await reopened.sync.run()).kind).toBe('synced');
	const expected = {
		'epicenter.json': discovery,
		'a.md': '2',
		'notes.md': 'mine',
		'z.md': 'new',
	};
	expect(folderFiles(opfs)).toEqual(expected);
	expect(await remoteFiles(bare)).toEqual(expected);
	expect(await changedPaths(reopened)).toEqual([]);
});

test('a tree turning a directory into a file, or a file into a directory, publishes', async () => {
	for (const [before, change, after] of [
		[
			{ 'a/b': 'child', keep: 'k' },
			{ 'a/b': null, a: 'file' },
			{ a: 'file', keep: 'k' },
		],
		[
			{ a: 'file', keep: 'k' },
			{ a: null, 'a/b': 'child' },
			{ 'a/b': 'child', keep: 'k' },
		],
	] as [Tree, Record<string, string | null>, Tree][]) {
		const { opfs, folder, push } = await synced(before);
		await push(change);
		expect(expectOk(await folder.sync.run()).kind).toBe('synced');
		expect(folderFiles(opfs)).toEqual({
			'epicenter.json': discovery,
			...after,
		});
		expect(await changedPaths(folder)).toEqual([]);
		for (const item of opened.splice(0)) await item.close();
	}
});

test('directories the removals emptied are pruned; one something else keeps stays', async () => {
	const { opfs, folder, push } = await synced({ 'x/y': 'y', 'gone/z': 'z' });
	expectOk(await folder.files.mkdir('x/keep'));
	await push({ 'x/y': null, 'gone/z': null });
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');
	const directories = opfs
		.directories(ROOT)
		.filter((path) => !path.startsWith('.git'));
	expect(directories).toEqual(['x', 'x/keep']);
});

test('a file this folder never committed, where Sync writes a file or needs a directory, refuses the publish before anything changes', async () => {
	for (const [change, blocked, blocker] of [
		// A file no path names, inside a directory the remote makes a file.
		[{ 'a/b': null, a: 'file' }, "'a'", `${ROOT}/a/.DS_Store`],
		// An ignored file where the remote adds one.
		[{ 'notes.log': 'theirs' }, "'notes.log'", `${ROOT}/notes.log`],
	] as const) {
		const { opfs, folder, push } = await synced({
			'a/b': 'child',
			'.gitignore': '*.log\n',
		});
		await push(change);
		opfs.put(blocker, encoder.encode('mine'));
		const head = expectOk(await folder.git.log(1))[0]?.oid;
		const refused = expectErr(await folder.sync.run());
		expect(refused.name).toBe('Blocked');
		expect(refused.message).toContain(blocked);
		expect(decoder.decode(stored(opfs, 'a/b'))).toBe('child');
		expect(decoder.decode(opfs.files().get(blocker))).toBe('mine');
		expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(head);
		for (const item of opened.splice(0)) await item.close();
	}
});

test('a file added here where the remote added a directory stands beside it', async () => {
	const { opfs, folder, bare, push } = await synced({ keep: 'k' });
	await push({ 'a/b': 'child' });
	expectOk(await folder.files.create('a', 'mine'));
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');
	expect(folderFiles(opfs)).toEqual({
		'epicenter.json': discovery,
		'a/b': 'child',
		'a~local': 'mine',
		keep: 'k',
	});
	expect(await remoteFiles(bare)).toEqual(folderFiles(opfs));
});

test('an empty first-commit ref, and a repository whose creation stopped before HEAD, keep working', async () => {
	const opfs = memoryOpfs();
	// A first commit whose ref creation never published.
	const made = await folderAt(opfs);
	await made.write('a.md', 'a');
	failWrite(opfs, `${ROOT}/.git/refs/heads/main`);
	expect((await made.history.commit()).status).toBe('failed');
	clearFaults(opfs);
	opfs.put(`${ROOT}/.git/refs/heads/main`, new Uint8Array());
	expect((await made.history.commit()).status).toBe('committed');
	expect(expectOk(await made.history.log(1))).toHaveLength(1);
	for (const item of opened.splice(0)) await item.close();

	// Creation wrote config and stopped before HEAD; another left HEAD empty.
	for (const head of [undefined, new Uint8Array()]) {
		const fresh = memoryOpfs();
		fresh.put(`${ROOT}/.git/config`, encoder.encode('[core]\n'));
		if (head !== undefined) fresh.put(`${ROOT}/.git/HEAD`, head);
		const folder = await folderAt(fresh);
		await folder.write('a.md', 'a');
		expect((await folder.history.commit()).status).toBe('committed');
		expect(decoder.decode(stored(fresh, '.git/HEAD'))).toBe(
			'ref: refs/heads/main\n',
		);
		for (const item of opened.splice(0)) await item.close();
	}
});

test('a commit whose branch write landed but whose reply was lost is unconfirmed, not failed', async () => {
	const made = await folderAt();
	await made.write('a.md', 'a');
	loseClose(made.opfs, `${ROOT}/.git/refs/heads/main`);
	const outcome = await made.history.commit();
	clearFaults(made.opfs);
	expect(outcome.status).toBe('unconfirmed');
	// It did land: history shows it, and the next commit sees nothing new.
	expect(expectOk(await made.history.log(1))).toHaveLength(1);
	expect((await made.history.commit()).status).toBe('unchanged');
});

test("a local pattern Sync brings in keeps its files out of this open folder's next commit", async () => {
	const { folder, bare, push } = await synced({});
	// Another device's definition keeps drafts on the machine that wrote them.
	await push({
		'epicenter.json': formatDeclaration(
			defineFolder({ kv: {}, tables: {}, local: ['drafts/'] }),
		),
	});
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');
	expectOk(await folder.files.create('drafts/secret.md', 'private'));
	expectOk(await folder.files.create('notes.md', 'shared'));
	expect(await changedPaths(folder)).toEqual(['notes.md']);
	expect((await folder.git.commit()).status).toBe('committed');
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');
	const tree = await git(bare, 'ls-tree', '-r', '--name-only', 'main');
	expect(tree.split('\n').sort()).toEqual(['epicenter.json', 'notes.md']);

	// A declaration that does not read leaves nothing known to keep local.
	await overwriteDeclaration(folder, '{ not json');
	expect(await folder.git.commit()).toMatchObject({
		status: 'blocked',
		reason: expect.stringContaining('epicenter.json'),
	});
});

async function overwriteDeclaration(folder: Opened, text: string) {
	const current = expectOk(await folder.files.read('epicenter.json'));
	expectOk(await folder.files.save(current, text));
}
