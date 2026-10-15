/**
 * Incoming updates of a browser folder in the origin private file system
 * (ADR-0545): files, then the index, then the branch, with nothing recorded,
 * so an update cut off partway is ordinary changed files that the next Sync
 * finishes.
 *
 * An update is interrupted by an injected failure: a write that throws before
 * its stream closed (nothing published), a close that throws (a created file
 * stays empty), or a close whose reply was lost (the bytes landed). These run over the in-memory OPFS stand-in; the remote is a
 * bare repository served by `git http-backend`.
 *
 * Key behaviors:
 * - A fast-forward or a merge cut off at a file, at the index, or at the
 *   branch leaves changed files that status shows; commits are not refused,
 *   and the next Sync lands on the remote's tree with local work kept
 * - Directories turn into files and files into directories; directories the
 *   removals emptied are pruned, and a directory something else keeps stays
 * - A directory, or a file no path names, where an update writes a file
 *   refuses the update before anything changes
 * - A first import into an empty history, an empty first-commit ref, and a
 *   repository whose creation stopped before `HEAD` keep working
 */
import { afterEach, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as isogit from 'isomorphic-git';
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
import { writeCommitObject, writeFilesTree } from './objects.js';
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
		store: createOpfsGitStore({
			root,
			locks: environment.locks,
			filesLock: FILES_LOCK,
			branch: 'main',
			landed: () => {},
		}),
		locks: environment.locks,
		lockName: GIT_LOCK,
		branch: 'main',
	});
	await backend.setRemote('http://unused.test/remote.git');
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
	async function commit() {
		const outcome = await history.commit();
		if (outcome.status !== 'committed') throw new Error(outcome.status);
		return outcome.oid;
	}
	/** Another owner's commit of exactly `tree`, recorded as the fetched head. */
	async function fetched(tree: Tree, parent: string | undefined) {
		const oid = await backend.withObjects(async (access) =>
			writeCommitObject(access, {
				tree: await writeFilesTree(
					access,
					new Map(
						Object.entries(tree).map(([path, text]) => [
							path,
							encoder.encode(text),
						]),
					),
				),
				parents: parent === undefined ? [] : [parent],
				message: 'Another owner',
				author,
			}),
		);
		await backend.withObjects((access) =>
			isogit.writeRef({
				...access,
				ref: 'refs/remotes/origin/main',
				value: oid,
				force: true,
			}),
		);
		return oid;
	}
	return { opfs, root, history, boundary, backend, write, commit, fetched };
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
async function synced(tree: Tree) {
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
		await writeFile(join(other, path), text);
		await git(other, 'add', path);
	}
	await git(other, 'commit', '--quiet', '-m', 'First');
	await git(other, 'push', '--quiet', 'origin', 'main');

	const opfs = memoryOpfs();
	const folder = expectOk(
		await openFolder({
			id: ROOT,
			definition,
			browser: {
				author,
				httpFetch: await gitHttpFetch(root),
				opfs: opfsEnvironment(opfs),
			},
		}),
	);
	opened.push(folder);
	expectOk(await folder.sync.connect(REMOTE_URL));
	return { opfs, folder, bare, push };
}

async function changedPaths(folder: Folder<typeof definition>) {
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

/** Where an update is cut off, and whether its branch write landed anyway. */
const faults: [string, (opfs: MemoryOpfs) => void, boolean][] = [
	['a file write', (opfs) => failWrite(opfs, `${ROOT}/z.md`), false],
	[
		'a file whose reply was lost',
		(opfs) => loseClose(opfs, `${ROOT}/z.md`),
		false,
	],
	[
		'a created file left empty',
		(opfs) => {
			opfs.faults.close = (path) =>
				path.endsWith(`${ROOT}/z.md`) ? 'fail' : undefined;
		},
		false,
	],
	['the index', (opfs) => failWrite(opfs, `${ROOT}/.git/index`), false],
	[
		'the branch',
		(opfs) => failWrite(opfs, `${ROOT}/.git/refs/heads/main`),
		false,
	],
	[
		'the branch whose reply was lost',
		(opfs) => loseClose(opfs, `${ROOT}/.git/refs/heads/main`),
		true,
	],
];

for (const [stage, fault, reached] of faults)
	test(`a fast-forward cut off at ${stage} is changed files, and the next Sync lands on the remote's tree with local work kept`, async () => {
		const { opfs, folder, bare, push } = await synced({
			'a.md': '1',
			'gone.md': 'gone',
		});
		await push({ 'a.md': '2', 'gone.md': null, 'z.md': 'new' });
		expectOk(await folder.git.fetch());

		fault(opfs);
		const stopped = expectErr(await folder.git.mergeIncoming());
		clearFaults(opfs);
		expect(stopped.name).toBe('Interrupted');
		// Removals, then writes: the removal and a.md landed before z.md.
		expect(stored(opfs, 'gone.md')).toBeUndefined();
		expect(decoder.decode(stored(opfs, 'a.md'))).toBe('2');
		expect(await changedPaths(folder)).toEqual(
			reached ? [] : expect.arrayContaining(['a.md', 'gone.md']),
		);

		// Nothing is pending: a save and a commit go ahead.
		expectOk(await folder.files.create('notes.md', 'mine'));
		expect((await folder.git.commit()).status).toBe('committed');

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
		expect(expectOk(await folder.git.paths())).toEqual([]);
		expect(await remoteFiles(bare)).toEqual(expected);
	});

for (const [stage, fault, reached] of faults)
	test(`a merge cut off at ${stage} is changed files, and the next Sync lands on both sides' changes`, async () => {
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
		// A local commit the remote does not have makes the update a merge.
		const b = expectOk(await folder.files.read('b.md'));
		expectOk(await folder.files.save(b, '2'));
		const shared = expectOk(await folder.files.read('shared.md'));
		expectOk(await folder.files.save(shared, 'one\ntwo\nTHREE\n'));
		expect((await folder.git.commit()).status).toBe('committed');
		expectOk(await folder.git.fetch());

		fault(opfs);
		const stopped = expectErr(await folder.git.mergeIncoming());
		clearFaults(opfs);
		expect(stopped.name).toBe('Interrupted');
		// The merged text landed before z.md stopped the update.
		expect(decoder.decode(stored(opfs, 'shared.md'))).toBe('ONE\ntwo\nTHREE\n');
		expect(await changedPaths(folder)).toEqual(
			reached ? [] : expect.arrayContaining(['a.md', 'gone.md', 'shared.md']),
		);

		const outcome = expectOk(await folder.sync.run());
		expect(outcome.kind).toBe('synced');
		const expected = {
			'epicenter.json': discovery,
			'a.md': '2',
			'b.md': '2',
			'shared.md': 'ONE\ntwo\nTHREE\n',
			'z.md': 'new',
		};
		expect(folderFiles(opfs)).toEqual(expected);
		expect(await changedPaths(folder)).toEqual([]);
		expect(await remoteFiles(bare)).toEqual(expected);
	});

test('an uninterrupted merge publishes files, index, and branch', async () => {
	const made = await folderAt();
	await made.write('epicenter.json', discovery);
	await made.write('a.md', '1');
	await made.write('b.md', '1');
	const base = await made.commit();
	const theirs = await made.fetched(
		{ 'epicenter.json': discovery, 'a.md': '2', 'b.md': '1', 'c.md': 'new' },
		base,
	);
	await made.write('b.md', '2');
	const ours = await made.commit();
	expect(expectOk(await made.history.mergeIncoming()).status).toBe('merged');
	expect(folderFiles(made.opfs)).toEqual({
		'epicenter.json': discovery,
		'a.md': '2',
		'b.md': '2',
		'c.md': 'new',
	});
	const [head] = expectOk(await made.history.log(1));
	expect(head?.parents).toEqual([ours, theirs]);
	expect(expectOk(await made.history.status()).changes).toEqual([]);
	expect(expectOk(await made.history.paths())).toEqual([]);
});

test('a first import into an empty history publishes', async () => {
	const made = await folderAt();
	const target = await made.fetched({ 'a.md': 'a', 'd/e.md': 'e' }, undefined);
	expect(expectOk(await made.history.pullFastForward())).toMatchObject({
		status: 'fastForwarded',
		from: undefined,
		to: target,
	});
	expect(folderFiles(made.opfs)).toEqual({ 'a.md': 'a', 'd/e.md': 'e' });
	expect(expectOk(await made.history.paths())).toEqual([]);
});

test('a tree turning a directory into a file, or a file into a directory, publishes', async () => {
	for (const [before, after] of [
		[
			{ 'a/b': 'child', keep: 'k' },
			{ a: 'file', keep: 'k' },
		],
		[
			{ a: 'file', keep: 'k' },
			{ 'a/b': 'child', keep: 'k' },
		],
	] as [Tree, Tree][]) {
		const made = await folderAt();
		for (const [path, text] of Object.entries(before))
			await made.write(path, text);
		const base = await made.commit();
		await made.fetched(after, base);
		expect(expectOk(await made.history.pullFastForward()).status).toBe(
			'fastForwarded',
		);
		expect(folderFiles(made.opfs)).toEqual(after);
		expect(expectOk(await made.history.paths())).toEqual([]);
		for (const item of opened.splice(0)) await item.close();
	}
});

test('directories the removals emptied are pruned; one something else keeps stays', async () => {
	const made = await folderAt();
	await made.write('x/y', 'y');
	await made.write('gone/z', 'z');
	const base = await made.commit();
	expectOk(await made.boundary.mkdir('x/keep'));
	await made.fetched({}, base);
	expect(expectOk(await made.history.pullFastForward()).status).toBe(
		'fastForwarded',
	);
	const directories = made.opfs
		.directories(ROOT)
		.filter((path) => !path.startsWith('.git'));
	expect(directories).toEqual(['x', 'x/keep']);
});

test('a directory, or an unnameable file, where an update writes a file refuses the update before anything changes', async () => {
	for (const blocker of [
		(made: Awaited<ReturnType<typeof folderAt>>) =>
			made.boundary.mkdir('a/mine').then(expectOk),
		async (made: Awaited<ReturnType<typeof folderAt>>) =>
			made.opfs.put(`${ROOT}/a/.DS_Store`, encoder.encode('finder')),
	]) {
		const made = await folderAt();
		await made.write('a/b', 'child');
		const base = await made.commit();
		await made.fetched({ a: 'file' }, base);
		await blocker(made);
		const refused = expectErr(await made.history.pullFastForward());
		expect(refused.name).toBe('Refused');
		expect(refused.message).toContain("'a' is a directory");
		expect(decoder.decode(stored(made.opfs, 'a/b'))).toBe('child');
		expect(await made.backend.readBranch()).toBe(base);
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
