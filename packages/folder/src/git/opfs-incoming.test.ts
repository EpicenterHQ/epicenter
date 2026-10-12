/**
 * Incoming updates of a browser folder in the origin private file system
 * (ADR-0474): one record from admission until the update is verified, and
 * recovery only when asked.
 *
 * An update is interrupted by an injected failure: a write that throws before
 * its stream closed (nothing published), or a close that throws (the outcome
 * is unknown, and the file may hold either version). Those leave the stored
 * state a closed tab would. The folder is then reopened through the
 * production opener. These run over the in-memory OPFS stand-in.
 *
 * Key behaviors:
 * - The record holds an operation ID, the branch, the admitted head, and the
 *   published commit; refs pin both commits while it exists
 * - A close whose outcome is unknown halts the update with its record, before
 *   the index or the branch, and requests no commit; nothing calls it a success
 * - A record whose creation never published is `unadmitted`: no authored file
 *   changed, and only an explicit recovery removes it
 * - Reopening, committing, and status resume nothing. Saves continue;
 *   staging, commits, and new incoming updates wait, across openings
 * - Recovery removes, then writes, then sets the index and the branch; a
 *   branch already at the published commit clears the record without writing
 * - Paths, the index, the branch, or the record in neither state are refused
 *   and named: an empty file where nothing was, a file above a new path, a
 *   staged or corrupt index, unreadable record bytes
 * - Directories turn into files and files into directories in both
 *   publication and recovery; directories the removals emptied are pruned,
 *   and a directory something else keeps stays
 * - A first import into an empty history, an empty first-commit ref, and a
 *   repository whose creation stopped before `HEAD` keep working
 */
import { afterEach, expect, test } from 'bun:test';
import * as isogit from 'isomorphic-git';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder, type Folder, openFolder } from '../browser.js';
import { hashBytes } from '../capture.js';
import { formatDeclaration } from '../declaration.js';
import {
	type MemoryOpfs,
	memoryOpfs,
	opfsEnvironment,
} from '../opfs.test-support.js';
import {
	createOpfsFileBoundary,
	ensureDirectory,
	READY_MARKER,
	writePrivateFile,
} from '../opfs-store.js';
import { useWebLocks } from '../web-locks.test-support.js';
import { createStoredGitBackend, GITDIR, WORKDIR } from './browser-backend.js';
import { createHistory } from './history.js';
import { writeCommitObject, writeFilesTree } from './objects.js';
import { createOpfsGitSession, createOpfsGitStore } from './opfs-git.js';

useWebLocks();

const author = { name: 'Merger', email: 'merger@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const remote = { url: 'http://unused.test/remote.git', branch: 'main' };
const ROOT = 'Epicenter/local/merge';
const RECORD = '.git/epicenter-incoming.json';
const PIN_NEXT = '.git/refs/epicenter/incoming/next';
const PIN_EXPECTED = '.git/refs/epicenter/incoming/expected';
const address = JSON.stringify(['release', 'local', null, 'merge']);
const FILES_LOCK = `epicenter-folder-opfs-files:${address}`;
const GIT_LOCK = `epicenter-folder-opfs-git:${address}`;
const definition = defineFolder({ kv: {}, tables: {} });
const discovery = formatDeclaration(definition);

type Tree = Record<string, string>;

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const item of opened.splice(0)) await item.close();
});

/** A raw folder where the opener looks for it, with history over it. */
async function folderAt(opfs = memoryOpfs()) {
	const environment = opfsEnvironment(opfs);
	const root = expectOk(
		await ensureDirectory(await environment.getDirectory(), ROOT),
	);
	await writePrivateFile(
		root,
		READY_MARKER,
		encoder.encode(JSON.stringify({ address })),
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
		remote,
	});
	const boundary = createOpfsFileBoundary({
		root,
		locks: environment.locks,
		filesLock: FILES_LOCK,
		landed: () => {},
	});
	const history = createHistory({
		backend,
		boundary,
		author,
	});
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

/** A folder with a diverged fetched head: merged, a=2 b=2 c=new. */
async function setup() {
	const made = await folderAt();
	await made.write('epicenter.json', discovery);
	// base a=1 b=1; theirs a=2 b=1 c=new; ours a=1 b=2.
	await made.write('a.md', '1');
	await made.write('b.md', '1');
	const base = await made.commit();
	const theirs = await made.fetched(
		{ 'epicenter.json': discovery, 'a.md': '2', 'b.md': '1', 'c.md': 'new' },
		base,
	);
	await made.write('b.md', '2');
	const ours = await made.commit();
	return { ...made, ours, theirs };
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

/** Make the `nth` close at a path ending with `suffix` throw: its outcome is unknown. */
function failClose(
	opfs: MemoryOpfs,
	suffix: string,
	fault: 'fail' | 'lost' = 'fail',
	nth = 1,
) {
	let seen = 0;
	opfs.faults.close = (path) => {
		if (!path.endsWith(suffix)) return undefined;
		seen++;
		return seen === nth ? fault : undefined;
	};
}

function clearFaults(opfs: MemoryOpfs) {
	opfs.faults.write = undefined;
	opfs.faults.close = undefined;
	opfs.faults.remove = undefined;
}

const MERGED = {
	'epicenter.json': discovery,
	'a.md': '2',
	'b.md': '2',
	'c.md': 'new',
};

function folderFiles(opfs: MemoryOpfs) {
	return Object.fromEntries(
		[...opfs.files(ROOT)]
			.filter(([path]) => !path.startsWith('.git/'))
			.map(([path, bytes]) => [path, decoder.decode(bytes)])
			.sort(([a], [b]) => (a! < b! ? -1 : 1)),
	);
}

const stored = (opfs: MemoryOpfs, path: string) => opfs.files(ROOT).get(path);

async function reopen(opfs: MemoryOpfs) {
	const folder = expectOk(
		await openFolder({
			id: 'merge',
			definition,
			browser: {
				author,
				remote,
				opfs: opfsEnvironment(opfs),
			},
		}),
	);
	opened.push(folder);
	// The pending record is read when history starts.
	for (let index = 0; index < 50; index++) {
		if (folder.git.snapshot.pendingIncoming !== undefined) break;
		await Bun.sleep(2);
	}
	return folder;
}

/** Interrupt the merge with `fault`, then reopen the folder. */
async function interrupted(fault: (opfs: MemoryOpfs) => void) {
	const made = await setup();
	fault(made.opfs);
	const stopped = expectErr(await made.history.mergeIncoming());
	clearFaults(made.opfs);
	await made.history.close();
	opened.length = 0;
	return { ...made, stopped, folder: await reopen(made.opfs) };
}

async function expectMerged(
	folder: Folder<typeof definition>,
	opfs: MemoryOpfs,
	ours: string,
	theirs: string,
) {
	expect(folderFiles(opfs)).toEqual(MERGED);
	expect(stored(opfs, RECORD)).toBeUndefined();
	expect(stored(opfs, PIN_NEXT)).toBeUndefined();
	expect(folder.git.snapshot.pendingIncoming).toBeUndefined();
	const [head] = expectOk(await folder.git.log(1));
	expect(head?.parents).toEqual([ours, theirs]);
	expect(expectOk(await folder.git.status()).changes).toEqual([]);
	expect(expectOk(await folder.git.paths())).toEqual([]);
}

test('an uninterrupted merge publishes and leaves no record or pin', async () => {
	const { opfs, history } = await setup();
	expect(expectOk(await history.mergeIncoming()).status).toBe('merged');
	expect(folderFiles(opfs)).toEqual(MERGED);
	expect(stored(opfs, RECORD)).toBeUndefined();
	expect(stored(opfs, PIN_NEXT)).toBeUndefined();
	expect(stored(opfs, PIN_EXPECTED)).toBeUndefined();
});

test('the record names the operation, branch, admitted head, and published commit; pins keep both commits', async () => {
	const { opfs, ours, stopped, folder } = await interrupted((opfs) =>
		failWrite(opfs, `${ROOT}/c.md`),
	);
	expect(stopped).toMatchObject({
		name: 'Partial',
		applied: [{ kind: 'write', path: 'a.md' }],
	});
	const record = JSON.parse(decoder.decode(stored(opfs, RECORD)));
	expect(Object.keys(record).sort()).toEqual([
		'branch',
		'expectedHead',
		'nextHead',
		'operationId',
	]);
	expect(record).toMatchObject({ branch: 'main', expectedHead: ours });
	expect(folder.git.snapshot.pendingIncoming).toEqual({
		state: 'recorded',
		operationId: record.operationId,
		branch: 'main',
		expectedHead: ours,
		nextHead: record.nextHead,
	});
	expect(decoder.decode(stored(opfs, PIN_NEXT)).trim()).toBe(record.nextHead);
	expect(decoder.decode(stored(opfs, PIN_EXPECTED)).trim()).toBe(ours);
});

test('while pending, saves land; staging, commits, and new incoming updates wait; nothing resumes it', async () => {
	const { opfs, folder, ours } = await interrupted((opfs) =>
		failWrite(opfs, `${ROOT}/c.md`),
	);
	const pending = folder.git.snapshot.pendingIncoming!;
	expect(pending.state).toBe('recorded');
	expect(expectOk(await folder.git.status()).changes.length).toBeGreaterThan(0);
	const commit = await folder.git.commit();
	expect(commit.status).toBe('blocked');
	expect(stored(opfs, RECORD)).toBeDefined();
	expect(folderFiles(opfs)).toEqual({
		'epicenter.json': discovery,
		'a.md': '2',
		'b.md': '2',
	});
	expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(ours);
	expectOk(await folder.files.create('notes.md', 'mine'));
	expectOk(await folder.files.mkdir('drafts'));
	expect(expectErr(await folder.git.mergeIncoming())).toMatchObject({
		name: 'IncomingPending',
		pending,
	});
	expect(expectErr(await folder.git.pullFastForward())).toMatchObject({
		name: 'IncomingPending',
	});
	expect(expectErr(await folder.git.stage(['notes.md']))).toMatchObject({
		name: 'IncomingPending',
	});
	expect(expectErr(await folder.git.commitStaged('Notes'))).toMatchObject({
		name: 'IncomingPending',
	});
	await folder.close();
	opened.length = 0;
	const again = await reopen(opfs);
	expect(again.git.snapshot.pendingIncoming).toEqual(pending);
	expect(stored(opfs, RECORD)).toBeDefined();
});

test('a close whose outcome is unknown halts the update with its record before the index and branch', async () => {
	// The bytes landed, but the reply was lost: still not a success.
	const lost = await setup();
	failClose(lost.opfs, `${ROOT}/c.md`, 'lost');
	const halted = expectErr(await lost.history.mergeIncoming());
	clearFaults(lost.opfs);
	expect(halted).toMatchObject({ name: 'Unconfirmed', uncertain: ['c.md'] });
	expect(folderFiles(lost.opfs)).toEqual(MERGED);
	expect(await lost.backend.readBranch()).toBe(lost.ours);
	expect(stored(lost.opfs, RECORD)).toBeDefined();
	expect(lost.history.snapshot.lastCommit?.status).toBe('committed');
	expect((await lost.history.commit()).status).toBe('blocked');
	// Recovery finds c.md already at its after state and finishes.
	expect(expectOk(await lost.history.recoverIncoming()).status).toBe(
		'completed',
	);
	expect(await lost.backend.readBranch()).not.toBe(lost.ours);

	// Nothing published: the created file is empty, a third state to review.
	const { opfs, folder, ours, theirs } = await interrupted((opfs) =>
		failClose(opfs, `${ROOT}/c.md`),
	);
	expect(stored(opfs, 'c.md')).toEqual(new Uint8Array());
	const refused = expectErr(await folder.git.recoverIncoming());
	expect(refused).toMatchObject({ name: 'RecoveryRefused', paths: ['c.md'] });
	// Removing what nobody can vouch for lets recovery finish.
	expectOk(
		await folder.files.remove(expectOk(await folder.files.read('c.md'))),
	);
	expect(expectOk(await folder.git.recoverIncoming()).status).toBe('completed');
	await expectMerged(folder, opfs, ours, theirs);
});

test('recovery finishes an update stopped at a file, at the index, or at the branch, and keeps edits beside it', async () => {
	for (const fault of [
		(opfs: MemoryOpfs) => failWrite(opfs, `${ROOT}/c.md`),
		(opfs: MemoryOpfs) => failWrite(opfs, `${ROOT}/.git/index`),
		(opfs: MemoryOpfs) => failClose(opfs, `${ROOT}/.git/index`),
		(opfs: MemoryOpfs) => failWrite(opfs, `${ROOT}/.git/refs/heads/main`),
		(opfs: MemoryOpfs) => failClose(opfs, `${ROOT}/.git/refs/heads/main`),
	]) {
		const { opfs, folder, ours, theirs } = await interrupted(fault);
		expect(folder.git.snapshot.pendingIncoming?.state).toBe('recorded');
		expectOk(await folder.files.create('notes.md', 'kept'));
		const heard: string[] = [];
		folder.onFilesChanged((paths) => heard.push(...paths));
		const recovered = expectOk(await folder.git.recoverIncoming());
		expect(recovered).toMatchObject({
			status: 'completed',
			changedPaths: ['a.md', 'c.md'],
		});
		expect(heard).toEqual(['a.md', 'c.md']);
		expect(decoder.decode(stored(opfs, 'notes.md'))).toBe('kept');
		opfs.drop(`${ROOT}/notes.md`);
		await expectMerged(folder, opfs, ours, theirs);
		expect(expectOk(await folder.git.recoverIncoming())).toEqual({
			status: 'none',
		});
		for (const item of opened.splice(0)) await item.close();
	}
});

test('a branch whose write landed but whose reply was lost is reported unknown, then cleared without replaying files', async () => {
	const made = await setup();
	failClose(made.opfs, `${ROOT}/.git/refs/heads/main`, 'lost');
	const halted = expectErr(await made.history.mergeIncoming());
	clearFaults(made.opfs);
	expect(halted).toMatchObject({
		name: 'Unconfirmed',
		uncertain: ['.git/refs/heads/main'],
	});
	expect(halted.message).not.toContain('did not move');
	const pending = made.history.snapshot.pendingIncoming;
	if (pending?.state !== 'recorded') throw new Error(String(pending?.state));
	// A save after the halt is not replayed over.
	const a = expectOk(await made.boundary.read('a.md'));
	const edited = encoder.encode('edited');
	expectOk(
		await made.boundary.apply([
			{
				kind: 'replace',
				path: 'a.md',
				bytes: edited,
				sha256: await hashBytes(edited),
				expectedSha256: a.sha256,
			},
		]),
	);
	expect(expectOk(await made.history.recoverIncoming())).toEqual({
		status: 'cleared',
		pending,
	});
	expect(decoder.decode(stored(made.opfs, 'a.md'))).toBe('edited');
	expect(stored(made.opfs, RECORD)).toBeUndefined();
	expect(expectOk(await made.history.status()).changes).toEqual([
		{ path: 'a.md', kind: 'modify' },
	]);
});

test('a branch already at the published commit clears the record without writing any file, and status is observed again', async () => {
	const { opfs, folder, theirs } = await interrupted((opfs) =>
		failWrite(opfs, `${ROOT}/c.md`),
	);
	const pending = folder.git.snapshot.pendingIncoming!;
	if (pending.state !== 'recorded') throw new Error(pending.state);
	opfs.put(
		`${ROOT}/.git/refs/heads/main`,
		encoder.encode(`${pending.nextHead}\n`),
	);
	expect(expectOk(await folder.git.recoverIncoming())).toEqual({
		status: 'cleared',
		pending,
	});
	expect(stored(opfs, RECORD)).toBeUndefined();
	expect(folderFiles(opfs)).toEqual({
		'epicenter.json': discovery,
		'a.md': '2',
		'b.md': '2',
	});
	expect(expectOk(await folder.git.status()).changes).toEqual([
		{ path: 'c.md', kind: 'delete' },
	]);
	const [head] = expectOk(await folder.git.log(1));
	expect(head?.parents[1]).toBe(theirs);
});

test('a branch at neither commit leaves the update pending', async () => {
	const { opfs, folder, backend } = await interrupted((opfs) =>
		failWrite(opfs, `${ROOT}/c.md`),
	);
	const elsewhere = await backend.withObjects((access) =>
		writeCommitObject(access, {
			tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
			parents: [],
			message: 'Elsewhere',
			author,
		}),
	);
	opfs.put(`${ROOT}/.git/refs/heads/main`, encoder.encode(`${elsewhere}\n`));
	expect(expectErr(await folder.git.recoverIncoming())).toMatchObject({
		name: 'RecoveryRefused',
		paths: ['.git/refs/heads/main'],
	});
	expect(stored(opfs, RECORD)).toBeDefined();
});

test('a path holding a third value refuses recovery and is named; restoring it lets recovery finish', async () => {
	const { opfs, folder, ours, theirs } = await interrupted((opfs) =>
		failWrite(opfs, `${ROOT}/c.md`),
	);
	const current = expectOk(await folder.files.read('a.md'));
	expectOk(await folder.files.replace(current, 'third'));
	const refused = expectErr(await folder.git.recoverIncoming());
	expect(refused).toMatchObject({ name: 'RecoveryRefused', paths: ['a.md'] });
	expect(refused.message).toContain(
		"a.md holds neither the update's before nor its after state",
	);
	expect(folderFiles(opfs)['c.md']).toBeUndefined();
	const third = expectOk(await folder.files.read('a.md'));
	expectOk(await folder.files.replace(third, '1'));
	expect(expectOk(await folder.git.recoverIncoming()).status).toBe('completed');
	await expectMerged(folder, opfs, ours, theirs);
});

test('a formerly absent path that is now empty, or under a file, is a third state', async () => {
	const empty = await interrupted((opfs) => failWrite(opfs, `${ROOT}/c.md`));
	empty.opfs.put(`${ROOT}/c.md`, new Uint8Array());
	expect(expectErr(await empty.folder.git.recoverIncoming())).toMatchObject({
		name: 'RecoveryRefused',
		paths: ['c.md'],
	});
	for (const item of opened.splice(0)) await item.close();

	// The update adds n.md and p/q; a save puts a file at p meanwhile.
	const made = await folderAt();
	await made.write('a.md', '1');
	const base = await made.commit();
	await made.fetched({ 'a.md': '1', 'n.md': 'n', 'p/q': 'q' }, base);
	failWrite(made.opfs, `${ROOT}/p/q`);
	expect(expectErr(await made.history.pullFastForward()).name).toBe('Partial');
	clearFaults(made.opfs);
	// The failed write left its parent directory; a save takes its place.
	expectOk(await made.boundary.rmdir('p'));
	await made.write('p', 'a file above p/q');
	const refused = expectErr(await made.history.recoverIncoming());
	expect(refused).toMatchObject({ name: 'RecoveryRefused', paths: ['p/q'] });
	expect(decoder.decode(stored(made.opfs, 'p'))).toBe('a file above p/q');
});

test('a staged or corrupt index refuses recovery and is named', async () => {
	const staged = await interrupted((opfs) => failWrite(opfs, `${ROOT}/c.md`));
	staged.opfs.put(`${ROOT}/extra.md`, encoder.encode('extra'));
	const session = createOpfsGitSession(staged.root);
	await isogit.add({
		fs: session.fs,
		dir: WORKDIR,
		gitdir: GITDIR,
		filepath: 'extra.md',
	});
	await session.flush();
	expect(expectErr(await staged.folder.git.recoverIncoming())).toMatchObject({
		name: 'RecoveryRefused',
		paths: ['.git/index'],
	});
	for (const item of opened.splice(0)) await item.close();

	for (const corrupt of [new Uint8Array(), encoder.encode('not an index')]) {
		const made = await interrupted((opfs) => failWrite(opfs, `${ROOT}/c.md`));
		made.opfs.put(`${ROOT}/.git/index`, corrupt);
		const refused = expectErr(await made.folder.git.recoverIncoming());
		expect(refused).toMatchObject({
			name: 'RecoveryRefused',
			paths: ['.git/index'],
		});
		expect(stored(made.opfs, RECORD)).toBeDefined();
		for (const item of opened.splice(0)) await item.close();
	}
});

test('a record whose creation never published is unadmitted: no authored file changed, and only recovery clears it', async () => {
	const { opfs, history, ours } = await setup();
	failClose(opfs, `${ROOT}/${RECORD}`);
	const halted = expectErr(await history.mergeIncoming());
	clearFaults(opfs);
	expect(halted).toMatchObject({ name: 'Unconfirmed', uncertain: [RECORD] });
	expect(stored(opfs, RECORD)).toEqual(new Uint8Array());
	expect(folderFiles(opfs)).toEqual({
		'epicenter.json': discovery,
		'a.md': '1',
		'b.md': '2',
	});
	expect(history.snapshot.pendingIncoming).toEqual({ state: 'unadmitted' });
	await history.close();
	opened.length = 0;
	const folder = await reopen(opfs);
	expect(folder.git.snapshot.pendingIncoming).toEqual({ state: 'unadmitted' });
	expect((await folder.git.commit()).status).toBe('blocked');
	expect(expectErr(await folder.git.mergeIncoming()).name).toBe(
		'IncomingPending',
	);
	expect(stored(opfs, RECORD)).toEqual(new Uint8Array());
	expect(expectOk(await folder.git.recoverIncoming())).toEqual({
		status: 'admissionCleared',
	});
	expect(stored(opfs, RECORD)).toBeUndefined();
	expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(ours);
	expect(expectOk(await folder.git.mergeIncoming()).status).toBe('merged');
	expect(folderFiles(opfs)).toEqual(MERGED);
});

test('a record write that throws before its stream closed leaves nothing, and the update is refused', async () => {
	const { opfs, history, ours } = await setup();
	failWrite(opfs, `${ROOT}/${RECORD}`);
	expect(expectErr(await history.mergeIncoming()).name).toBe('Refused');
	clearFaults(opfs);
	expect(stored(opfs, RECORD)).toBeUndefined();
	expect(history.snapshot.pendingIncoming).toBeUndefined();
	expect(await history.commit()).toMatchObject({ status: 'unchanged' });
	expect(expectOk(await history.log(1))[0]?.oid).toBe(ours);
});

test('record bytes that are not a record are refused, named, and kept', async () => {
	const { opfs, history } = await setup();
	opfs.put(`${ROOT}/${RECORD}`, encoder.encode('{"half":'));
	const folder = await reopen(opfs);
	expect(folder.git.snapshot.pendingIncoming?.state).toBe('unreadable');
	const refused = expectErr(await folder.git.recoverIncoming());
	expect(refused).toMatchObject({ name: 'RecoveryRefused', paths: [RECORD] });
	expect(decoder.decode(stored(opfs, RECORD))).toBe('{"half":');
	expect((await history.commit()).status).toBe('blocked');
});

test('a first import into an empty history publishes, and recovers when its index step stops', async () => {
	const made = await folderAt();
	const target = await made.fetched({ 'a.md': 'a', 'd/e.md': 'e' }, undefined);
	expect(expectOk(await made.history.pullFastForward())).toMatchObject({
		status: 'fastForwarded',
		from: undefined,
		to: target,
	});
	expect(folderFiles(made.opfs)).toEqual({ 'a.md': 'a', 'd/e.md': 'e' });
	expect(expectOk(await made.history.paths())).toEqual([]);
	for (const item of opened.splice(0)) await item.close();

	const stopped = await folderAt();
	const next = await stopped.fetched({ 'a.md': 'a' }, undefined);
	// The first index write is the valid empty index admission gives a
	// history that has none; the second is the update's.
	failClose(stopped.opfs, `${ROOT}/.git/index`, 'fail', 2);
	expect(expectErr(await stopped.history.pullFastForward()).name).toBe(
		'Unconfirmed',
	);
	clearFaults(stopped.opfs);
	// A valid empty index was there before the update replaced it.
	const recovered = expectOk(await stopped.history.recoverIncoming());
	expect(recovered.status).toBe('completed');
	expect(await stopped.backend.readBranch()).toBe(next);
	expect(expectOk(await stopped.history.paths())).toEqual([]);
});

test('a tree turning a directory into a file, or a file into a directory, publishes and recovers', async () => {
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

		// Stopped at the write after the removal: recovery removes first too.
		const stopped = await folderAt();
		for (const [path, text] of Object.entries(before))
			await stopped.write(path, text);
		const stoppedBase = await stopped.commit();
		await stopped.fetched(after, stoppedBase);
		const written = Object.keys(after).find((path) => !(path in before))!;
		failWrite(stopped.opfs, `${ROOT}/${written}`);
		expect(expectErr(await stopped.history.pullFastForward()).name).toBe(
			'Partial',
		);
		clearFaults(stopped.opfs);
		expect(expectOk(await stopped.history.recoverIncoming()).status).toBe(
			'completed',
		);
		expect(folderFiles(stopped.opfs)).toEqual(after);
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

test('a directory where an update writes a file, which the update does not empty, refuses recovery before anything changes', async () => {
	const made = await folderAt();
	await made.write('a', 'old');
	await made.write('c', 'delete me');
	const base = await made.commit();
	const target = await made.fetched({ a: 'new', z: 'new z' }, base);
	failClose(made.opfs, `${ROOT}/a`, 'lost');
	expect(expectErr(await made.history.pullFastForward()).name).toBe(
		'Unconfirmed',
	);
	clearFaults(made.opfs);
	// The before state comes back, and someone makes a directory at z.
	await made.write('a', 'old');
	await made.write('c', 'delete me');
	expectOk(await made.boundary.mkdir('z'));
	const refused = expectErr(await made.history.recoverIncoming());
	expect(refused).toMatchObject({ name: 'RecoveryRefused', paths: ['z'] });
	// Nothing was removed or written, z included.
	expect(folderFiles(made.opfs)).toEqual({ a: 'old', c: 'delete me' });
	expect(made.opfs.directories(ROOT)).toContain('z');
	expect(stored(made.opfs, RECORD)).toBeDefined();
	// A file in a directory nobody can name refuses as well.
	expectOk(await made.boundary.rmdir('z'));
	made.opfs.put(`${ROOT}/z/.DS_Store`, encoder.encode('finder'));
	expect(expectErr(await made.history.recoverIncoming())).toMatchObject({
		name: 'RecoveryRefused',
		paths: ['z'],
	});
	expect(folderFiles(made.opfs)).toEqual({
		a: 'old',
		c: 'delete me',
		'z/.DS_Store': 'finder',
	});
	await (await made.root.getDirectoryHandle('z')).removeEntry('.DS_Store');
	expectOk(await made.boundary.rmdir('z'));
	expect(expectOk(await made.history.recoverIncoming()).status).toBe(
		'completed',
	);
	expect(folderFiles(made.opfs)).toEqual({ a: 'new', z: 'new z' });
	expect(await made.backend.readBranch()).toBe(target);
});

test('a directory turning into a file that stopped before its directory was pruned recovers by pruning only what the update emptied', async () => {
	async function stoppedBeforePruning() {
		const made = await folderAt();
		await made.write('a/b', 'child');
		await made.write('keep', 'k');
		const base = await made.commit();
		await made.fetched({ a: 'file', keep: 'k' }, base);
		// Every removal of the directory a fails: a/b is gone, a stays.
		made.opfs.faults.remove = (path) =>
			path === `${ROOT}/a` ? 'fail' : undefined;
		expect(expectErr(await made.history.pullFastForward()).name).toBe(
			'Partial',
		);
		clearFaults(made.opfs);
		expect(folderFiles(made.opfs)).toEqual({ keep: 'k' });
		expect(made.opfs.directories(ROOT)).toContain('a');
		return made;
	}

	const made = await stoppedBeforePruning();
	expect(expectOk(await made.history.recoverIncoming()).status).toBe(
		'completed',
	);
	expect(folderFiles(made.opfs)).toEqual({ a: 'file', keep: 'k' });
	expect(expectOk(await made.history.paths())).toEqual([]);
	for (const item of opened.splice(0)) await item.close();

	// A directory inside it that no removed file lived in is someone else's.
	const kept = await stoppedBeforePruning();
	expectOk(await kept.boundary.mkdir('a/mine'));
	expect(expectErr(await kept.history.recoverIncoming())).toMatchObject({
		name: 'RecoveryRefused',
		paths: ['a'],
	});
	expect(kept.opfs.directories(ROOT)).toContain('a/mine');
	expectOk(await kept.boundary.rmdir('a/mine'));
	expect(expectOk(await kept.history.recoverIncoming()).status).toBe(
		'completed',
	);
	expect(folderFiles(kept.opfs)).toEqual({ a: 'file', keep: 'k' });
});

test('a directory, or an unnameable file, where an update writes a file refuses the update before anything is recorded', async () => {
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
		expect(stored(made.opfs, RECORD)).toBeUndefined();
		expect(stored(made.opfs, PIN_NEXT)).toBeUndefined();
		expect(decoder.decode(stored(made.opfs, 'a/b'))).toBe('child');
		expect(await made.backend.readBranch()).toBe(base);
		expect(made.history.snapshot.pendingIncoming).toBeUndefined();
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
	failClose(made.opfs, `${ROOT}/.git/refs/heads/main`, 'lost');
	const outcome = await made.history.commit();
	clearFaults(made.opfs);
	expect(outcome.status).toBe('unconfirmed');
	// It did land: history shows it, and the next commit sees nothing new.
	expect(expectOk(await made.history.log(1))).toHaveLength(1);
	expect((await made.history.commit()).status).toBe('unchanged');
});
