/**
 * What Sync writes into a browser folder in the origin private file system
 * (ADR-0576): a journal naming the commit it publishes, then the files, the
 * index, and the branch, then the journal's removal. A publish cut off
 * partway leaves its journal, and the next commit or Sync finishes it before
 * it records anything.
 *
 * A publish is interrupted by an injected failure: a write that throws before
 * its stream closed (nothing published), a close that throws (a created file
 * stays empty), or a close whose reply was lost (the bytes landed). These run
 * over the in-memory OPFS stand-in; the remote is a bare repository served by
 * `git http-backend`.
 *
 * Key behaviors:
 * - A fast-forward or a merge cut off at a file, at the index, at the
 *   branch, or at the journal's removal is finished by the next Sync, with
 *   local work kept, and lands on the remote's tree
 * - A folder reopened over a cut-off publish finishes it before its next
 *   version, and a journal that does not read stops commits until removed
 * - Directories turn into files and files into directories; directories the
 *   removals emptied are pruned, and a directory something else keeps stays
 * - A directory, or a file no path names, where Sync writes a file refuses
 *   the publish before anything changes
 * - An empty first-commit ref, and a repository whose creation stopped before
 *   `HEAD`, keep working
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder, type Folder, openFolder } from '../browser.js';
import { hashBytes } from '../capture.js';
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
import { createOpfsFileBoundary, ensureDirectory } from '../opfs-store.js';
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
const JOURNAL = '.git/epicenter/sync-journal.json';
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
		store: createOpfsGitStore({ root }),
		locks: environment.locks,
		lockName: GIT_LOCK,
		branch: 'main',
	});
	const boundary = createOpfsFileBoundary({
		root,
		locks: environment.locks,
		filesLock: FILES_LOCK,
		landed: () => {},
	});
	const history = createHistory({ backend, boundary, author });
	opened.push(history);

	async function write(path: string, value: string) {
		const bytes = encoder.encode(value);
		expectOk(
			await boundary.apply([
				{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
			]),
		);
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
				await git(other, 'add', path);
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
const faults: [string, (opfs: MemoryOpfs) => void][] = [
	['a file write', (opfs) => failWrite(opfs, `${ROOT}/z.md`)],
	['a file whose reply was lost', (opfs) => loseClose(opfs, `${ROOT}/z.md`)],
	[
		'a created file left empty',
		(opfs) => {
			opfs.faults.close = (path) =>
				path.endsWith(`${ROOT}/z.md`) ? 'fail' : undefined;
		},
	],
	['the index', (opfs) => failWrite(opfs, `${ROOT}/.git/index`)],
	['the branch', (opfs) => failWrite(opfs, `${ROOT}/.git/refs/heads/main`)],
	[
		'the branch whose reply was lost',
		(opfs) => loseClose(opfs, `${ROOT}/.git/refs/heads/main`),
	],
	[
		"the journal's removal",
		(opfs) => {
			opfs.faults.remove = (path) =>
				path.endsWith(`${ROOT}/${JOURNAL}`) ? 'fail' : undefined;
		},
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
		// Removals, then writes: the removal and a.md landed before z.md.
		expect(stored(opfs, 'gone.md')).toBeUndefined();
		expect(decoder.decode(stored(opfs, 'a.md'))).toBe('2');

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
		expect(stored(opfs, JOURNAL)).toBeUndefined();
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
		expect(decoder.decode(stored(opfs, 'shared.md'))).toBe(
			'ONE\ntwo\nTHREE\n',
		);

		const outcome = expectOk(await folder.sync.run());
		expect(outcome.kind).toBe('synced');
		expect(folderFiles(opfs)).toEqual(expected);
		expect(stored(opfs, JOURNAL)).toBeUndefined();
		expect(await changedPaths(folder)).toEqual([]);
		expect(await remoteFiles(bare)).toEqual(expected);
	});

test('a folder reopened over a cut-off publish finishes it before its next version', async () => {
	const { opfs, folder, push, open } = await synced({ 'a.md': '1' });
	await push({ 'a.md': '2', 'z.md': 'new' });
	failWrite(opfs, `${ROOT}/z.md`);
	expect((await folder.sync.run()).error).not.toBeNull();
	clearFaults(opfs);
	expect(stored(opfs, JOURNAL)).toBeDefined();
	await folder.close();

	const reopened = await open();
	expectOk(await reopened.files.create('notes.md', 'mine'));
	expect((await reopened.git.commit()).status).toBe('committed');
	expect(stored(opfs, JOURNAL)).toBeUndefined();
	expect(folderFiles(opfs)).toEqual({
		'epicenter.json': discovery,
		'a.md': '2',
		'notes.md': 'mine',
		'z.md': 'new',
	});
	// The version holds the remote's files and the new one, nothing reverted.
	expect(await changedPaths(reopened)).toEqual([]);
});

test('a journal that does not read stops commits, naming it, until it is removed', async () => {
	const { opfs, folder } = await synced({ 'a.md': '1' });
	opfs.put(`${ROOT}/${JOURNAL}`, encoder.encode('{"version":'));
	expectOk(await folder.files.create('notes.md', 'mine'));
	const commit = await folder.git.commit();
	expect(commit.status).toBe('blocked');
	expect(JSON.stringify(commit)).toContain('sync-journal.json');
	opfs.drop(`${ROOT}/${JOURNAL}`);
	expect((await folder.git.commit()).status).toBe('committed');
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

test('a file in a directory where Sync writes a file refuses the publish before anything changes', async () => {
	for (const blocker of [
		(folder: Opened) => folder.files.create('a/mine', 'mine').then(expectOk),
		async (_folder: Opened, opfs: MemoryOpfs) =>
			opfs.put(`${ROOT}/a/.DS_Store`, encoder.encode('finder')),
	]) {
		const { opfs, folder, push } = await synced({ 'a/b': 'child' });
		await push({ 'a/b': null, a: 'file' });
		await blocker(folder, opfs);
		const refused = expectErr(await folder.sync.run());
		expect(refused.name).toBe('Blocked');
		expect(refused.message).toContain("'a'");
		expect(decoder.decode(stored(opfs, 'a/b'))).toBe('child');
		expect(stored(opfs, JOURNAL)).toBeUndefined();
		for (const item of opened.splice(0)) await item.close();
	}
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
		expect(decoder.decode(stored(fresh, '.git/HEAD'))).toBe(
			'ref: refs/heads/main\n',
		);
		await folder.write('a.md', 'a');
		expect((await folder.history.commit()).status).toBe('committed');
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
