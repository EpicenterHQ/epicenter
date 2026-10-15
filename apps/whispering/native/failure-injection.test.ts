/**
 * The injected failures write to a folder this host does not own, so each must
 * behave like a careful outside program.
 *
 * The commit failure uses Git's own branch lock path: it takes the lock only
 * when it is free and releases only the lock it took. The publication failure
 * puts a directory at one of a recording's two paths and removes only what it
 * made. These run against a real repository, real lock files, and real
 * directories.
 *
 * The repository is opened here with the Bun directory opener, standing in
 * for the page, and its first commit creates Git. The injection is never
 * given that folder.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { openTestFolder } from '../src/lib/workspace.test-support.js';
import {
	createFailureInjection,
	LOCK_MARKER_PREFIX,
} from './failure-injection.js';
import { createHost } from './host.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * The folder opened as the page opens it, with the repository its first
 * commit creates: opening alone creates none.
 */
async function openWithHistory(root: string) {
	const folder = await openTestFolder(root);
	await folder.git.commit();
	return folder;
}

/** An empty directory: what the host is given before the page has opened it. */
async function directory() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-lock-')),
	);
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	return root;
}

/** A directory the page has opened, so Git exists in it. */
async function open() {
	const root = await directory();
	const folder = await openWithHistory(root);
	cleanups.push(() => folder.close());
	return {
		root,
		folder,
		lock: join(root, '.git', 'refs', 'heads', 'main.lock'),
	};
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

test('the injected lock is created and removed by the host that owns it', async () => {
	const { root, lock } = await open();
	const injection = createFailureInjection({ root });

	expect((await injection.arm({ commitsBlocked: true })).commitsBlocked).toBe(
		true,
	);
	expect(await readFile(lock, 'utf8')).toMatch(LOCK_MARKER_PREFIX);

	expect((await injection.arm({ commitsBlocked: false })).commitsBlocked).toBe(
		false,
	);
	expect(await exists(lock)).toBe(false);
});

test('before Git exists, the lock is on the branch the first commit creates, and released leaves nothing', async () => {
	const root = await directory();
	const injection = createFailureInjection({ root });
	const lock = join(root, '.git', 'refs', 'heads', 'main.lock');

	// No repository is made to have a branch: only the lock's own path.
	await injection.arm({ commitsBlocked: true });
	expect(await readFile(lock, 'utf8')).toMatch(LOCK_MARKER_PREFIX);
	expect(await exists(join(root, '.git', 'HEAD'))).toBe(false);
	await injection.release();
	expect(await readdir(root)).toEqual([]);

	// The first commit creates the repository and fails on the lock.
	await injection.arm({ commitsBlocked: true });
	const folder = await openTestFolder(root);
	cleanups.push(() => folder.close());
	expectOk(await folder.files.create('note.md', 'one\n'));
	expect((await folder.git.commit()).status).not.toBe('committed');
	expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('one\n');

	await injection.arm({ commitsBlocked: false });
	expect(await exists(lock)).toBe(false);
	expect((await folder.git.commit()).status).toBe('committed');
});

test('the lock is taken on the branch HEAD names', async () => {
	const { root } = await open();
	const injection = createFailureInjection({ root });
	execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/drafts/one'], {
		cwd: root,
	});
	await injection.arm({ commitsBlocked: true });
	expect(
		await readFile(
			join(root, '.git', 'refs', 'heads', 'drafts', 'one.lock'),
			'utf8',
		),
	).toMatch(LOCK_MARKER_PREFIX);

	// The lock is released where it was taken, wherever HEAD points by then.
	execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
		cwd: root,
	});
	await injection.release();
	expect(
		await exists(join(root, '.git', 'refs', 'heads', 'drafts', 'one.lock')),
	).toBe(false);
	expect(await exists(join(root, '.git', 'refs', 'heads', 'main.lock'))).toBe(
		false,
	);
});

test('a HEAD that names no branch inside the repository locks nothing', async () => {
	const { root } = await open();
	const injection = createFailureInjection({ root });
	const before = (await readdir(join(root, '.git'))).sort();

	for (const head of [
		'4b825dc642cb6eb9a060e54bf8d69288fbee4904\n',
		'ref: refs/heads/../../../../escaped\n',
		'ref: refs/tags/v1\n',
	]) {
		await writeFile(join(root, '.git', 'HEAD'), head);
		await expect(injection.arm({ commitsBlocked: true })).rejects.toThrow(
			'does not name a branch',
		);
	}

	expect(injection.state.commitsBlocked).toBe(false);
	expect((await readdir(join(root, '.git'))).sort()).toEqual(before);
	expect(await exists(join(root, '..', 'escaped.lock'))).toBe(false);
});

test('a lock another Git process holds is never replaced or removed', async () => {
	const { root, lock } = await open();
	// What `git update-ref` writes while it holds the branch: the new value.
	const theirs = '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n';
	await writeFile(lock, theirs, { flag: 'wx' });
	const injection = createFailureInjection({ root });

	await expect(injection.arm({ commitsBlocked: true })).rejects.toThrow(
		'held by another Git process',
	);
	expect(injection.state.commitsBlocked).toBe(false);
	expect(await readFile(lock, 'utf8')).toBe(theirs);

	// Neither disarming nor stopping the host touches a lock it does not own.
	await injection.arm({ commitsBlocked: false });
	await injection.release();
	expect(await readFile(lock, 'utf8')).toBe(theirs);
});

test('a lock that replaced ours is theirs, and is left alone', async () => {
	const { root, lock } = await open();
	const injection = createFailureInjection({ root });
	await injection.arm({ commitsBlocked: true });
	// Someone cleared our lock and a Git process then took the branch.
	const theirs = '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n';
	await writeFile(lock, theirs);

	await injection.arm({ commitsBlocked: false });
	await injection.release();

	expect(await readFile(lock, 'utf8')).toBe(theirs);
});

test('one debug host never releases another debug host’s lock', async () => {
	const { root, lock } = await open();
	const first = createFailureInjection({ root });
	const second = createFailureInjection({ root });
	await first.arm({ commitsBlocked: true });
	const held = await readFile(lock, 'utf8');

	await expect(second.arm({ commitsBlocked: true })).rejects.toThrow(
		'earlier debug session',
	);
	await second.arm({ commitsBlocked: false });
	await second.release();
	expect(await readFile(lock, 'utf8')).toBe(held);

	await first.release();
	expect(await exists(lock)).toBe(false);
});

test('starting and stopping a debug host leaves an existing branch lock in place', async () => {
	const { root, lock } = await open();
	const theirs = '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n';
	await writeFile(lock, theirs, { flag: 'wx' });
	const logged: string[] = [];
	const start = (env: Record<string, string>) =>
		createHost({
			root,
			token: 'test-token',
			uiDist: undefined,
			debug: true,
			fixturePath: undefined,
			env,
			log: (message) => logged.push(message),
		});
	const ask = (host: Awaited<ReturnType<typeof start>>, op: string) =>
		host.handle(
			new Request('http://127.0.0.1/bridge/app', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: 'Bearer test-token',
				},
				body: JSON.stringify({ op, payload: {} }),
			}),
		);

	const plain = await start({});
	await plain.close();
	expect(await readFile(lock, 'utf8')).toBe(theirs);

	// Asking for the injected lock at launch does not take it from its holder.
	const armed = await start({ WHISPERING_DEBUG_BLOCK_COMMITS: '1' });
	expect(logged.join('\n')).toContain('held by another Git process');
	const state = (await (await ask(armed, 'injection')).json()) as {
		ok: { commitsBlocked: boolean };
	};
	expect(state.ok.commitsBlocked).toBe(false);
	await armed.close();
	expect(await readFile(lock, 'utf8')).toBe(theirs);
});

test('the real lock blocks a real Git ref update, and releasing it unblocks it', async () => {
	const { root, folder } = await open();
	const first = expectOk(await folder.files.create('note.md', 'one\n'));
	expect((await folder.git.commit()).status).toBe('committed');
	const head = execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: root,
		encoding: 'utf8',
	}).trim();
	const injection = createFailureInjection({ root });
	await injection.arm({ commitsBlocked: true });

	expect(() =>
		execFileSync('git', ['update-ref', 'refs/heads/main', head], {
			cwd: root,
			stdio: 'pipe',
		}),
	).toThrow();
	expectOk(await folder.files.save(first, 'two\n'));
	expect((await folder.git.commit()).status).not.toBe('committed');
	expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('two\n');

	await injection.release();
	expect((await folder.git.commit()).status).toBe('committed');
});

test('an obstacle is one empty directory at a recording’s own path, and its removal removes only that', async () => {
	const root = await directory();
	const injection = createFailureInjection({
		root,
		launch: { rowWrites: 1, audioWrites: 1 },
	});

	// A recording's audio write: the audio is what an armed audio failure obstructs.
	const audio = await injection.obstruct({
		step: 'audio',
		stem: 'take',
		path: 'recordings/take.wav',
	});
	expect(audio).not.toBeNull();
	expect((await stat(join(root, 'recordings', 'take.wav'))).isDirectory()).toBe(
		true,
	);
	expect(injection.state).toMatchObject({ rowWrites: 1, audioWrites: 0 });
	await injection.clear(audio);
	// The directory and the parent it had to make are gone.
	expect(await readdir(root)).toEqual([]);

	// A row write is obstructed at the row, never at the audio beside it.
	await mkdir(join(root, 'recordings'));
	await writeFile(join(root, 'recordings', 'take.wav'), 'audio');
	const row = await injection.obstruct({ step: 'row', stem: 'take' });
	expect((await stat(join(root, 'recordings', 'take.md'))).isDirectory()).toBe(
		true,
	);
	expect(injection.state).toMatchObject({ rowWrites: 0, audioWrites: 0 });
	// Removing it twice, or naming an obstacle this host never made, removes nothing more.
	await injection.clear(row);
	await injection.clear(row);
	await injection.clear('not-an-obstacle');
	expect(await readdir(join(root, 'recordings'))).toEqual(['take.wav']);

	// Nothing armed: nothing is placed.
	expect(
		await injection.obstruct({
			step: 'audio',
			stem: 'b',
			path: 'recordings/b.wav',
		}),
	).toBeNull();
	expect(await injection.obstruct({ step: 'row', stem: 'b' })).toBeNull();
	expect(await readdir(join(root, 'recordings'))).toEqual(['take.wav']);
});

test('a write is obstructed only by a failure armed for its own step', async () => {
	const root = await directory();
	const injection = createFailureInjection({
		root,
		launch: { rowWrites: 1, audioWrites: 0 },
	});

	// A row failure armed: the audio write before it is not in the way of anything.
	expect(
		await injection.obstruct({
			step: 'audio',
			stem: 'take',
			path: 'recordings/take.wav',
		}),
	).toBeNull();
	expect(injection.state).toMatchObject({ rowWrites: 1, audioWrites: 0 });
	const row = await injection.obstruct({ step: 'row', stem: 'take' });
	expect(row).not.toBeNull();
	expect(injection.state).toMatchObject({ rowWrites: 0, audioWrites: 0 });
	await injection.clear(row);
});

test('an occupied path is left alone and the failure is not spent on it', async () => {
	const root = await directory();
	await mkdir(join(root, 'recordings'));
	const foreign = '---\ntitle: Someone else\n---\nKeep me\n';
	await writeFile(join(root, 'recordings', 'take.md'), foreign);
	await writeFile(join(root, 'recordings', 'take.wav'), 'someone’s audio');
	const injection = createFailureInjection({
		root,
		launch: { rowWrites: 1, audioWrites: 1 },
	});

	expect(
		await injection.obstruct({
			step: 'audio',
			stem: 'take',
			path: 'recordings/take.wav',
		}),
	).toBeNull();
	expect(await injection.obstruct({ step: 'row', stem: 'take' })).toBeNull();

	expect(injection.state).toMatchObject({ rowWrites: 1, audioWrites: 1 });
	expect(await readFile(join(root, 'recordings', 'take.md'), 'utf8')).toBe(
		foreign,
	);
	expect(await readFile(join(root, 'recordings', 'take.wav'), 'utf8')).toBe(
		'someone’s audio',
	);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		'take.md',
		'take.wav',
	]);

	// A file where the recordings directory would be.
	const other = await directory();
	await writeFile(join(other, 'recordings'), 'a file, not a directory');
	const blocked = createFailureInjection({
		root: other,
		launch: { rowWrites: 1, audioWrites: 1 },
	});
	expect(
		await blocked.obstruct({
			step: 'audio',
			stem: 'take',
			path: 'recordings/take.wav',
		}),
	).toBeNull();
	expect(await blocked.obstruct({ step: 'row', stem: 'take' })).toBeNull();
	expect(blocked.state).toMatchObject({ rowWrites: 1, audioWrites: 1 });
	expect(await readFile(join(other, 'recordings'), 'utf8')).toBe(
		'a file, not a directory',
	);
});

test('overlapping obstacles for one armed failure place one, and the count never goes below zero', async () => {
	const root = await directory();
	// Each recording's audio landed before its row write.
	await mkdir(join(root, 'recordings'));
	await writeFile(join(root, 'recordings', 'first.wav'), 'audio');
	await writeFile(join(root, 'recordings', 'second.wav'), 'audio');
	const injection = createFailureInjection({ root, launch: { rowWrites: 1 } });

	// Two quick retries of different recordings ask at once.
	const placed = (
		await Promise.all([
			injection.obstruct({ step: 'row', stem: 'first' }),
			injection.obstruct({ step: 'row', stem: 'second' }),
		])
	).filter((obstacle) => obstacle !== null);

	expect(placed).toHaveLength(1);
	expect(injection.state.rowWrites).toBe(0);
	expect(await readdir(join(root, 'recordings'))).toHaveLength(3);
	// The one failure is spent: the next row write is not obstructed.
	expect(await injection.obstruct({ step: 'row', stem: 'third' })).toBeNull();
	expect(injection.state.rowWrites).toBe(0);
	await injection.clear(placed[0]);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		'first.wav',
		'second.wav',
	]);
});

test('an obstacle is placed only at a recording’s row or the audio a capture of it is saved at', async () => {
	const directoryOutside = await directory();
	const root = join(directoryOutside, 'data');
	await mkdir(root);
	await mkdir(join(directoryOutside, 'outside'));
	const injection = createFailureInjection({
		root,
		launch: { rowWrites: 5, audioWrites: 5 },
	});

	for (const write of [
		{ step: 'row', stem: '../escape' },
		{ step: 'row', stem: 'a/b' },
		{ step: 'row', stem: 'a\\b' },
		{ step: 'row', stem: 7 },
		{ step: 'audio', stem: 'take', path: '../outside/take.wav' },
		{ step: 'audio', stem: 'take', path: '/tmp/take.wav' },
		{ step: 'audio', stem: 'take', path: '.git/refs/heads/main.lock' },
		{ step: 'audio', stem: 'take', path: 7 },
		{ step: 'audio', stem: 'take', path: undefined },
		// Not where a capture of this recording is saved.
		{ step: 'audio', stem: 'take', path: 'media/take.wav' },
		{ step: 'audio', stem: 'take', path: 'recordings/other.wav' },
		{ step: 'audio', stem: 'take', path: 'recordings/take.' },
		// The row is not audio.
		{ step: 'audio', stem: 'take', path: 'recordings/take.md' },
		// Neither write of a recording.
		{ step: 'batch', stem: 'take', path: 'recordings/take.wav' },
		{ stem: 'take', path: 'recordings/take.wav' },
	])
		await expect(injection.obstruct(write)).rejects.toThrow();

	// A directory on the way that is a link out of the folder.
	await symlink(join(directoryOutside, 'outside'), join(root, 'recordings'));
	await expect(
		injection.obstruct({
			step: 'audio',
			stem: 'take',
			path: 'recordings/take.wav',
		}),
	).rejects.toThrow();
	await expect(
		injection.obstruct({ step: 'row', stem: 'take' }),
	).rejects.toThrow();

	expect(injection.state).toMatchObject({ rowWrites: 5, audioWrites: 5 });
	expect(await readdir(root)).toEqual(['recordings']);
	expect(await readdir(join(directoryOutside, 'outside'))).toEqual([]);
	expect((await readdir(directoryOutside)).sort()).toEqual(['data', 'outside']);
});

test('stopping the host removes an obstacle the page never had removed', async () => {
	const root = await directory();
	const injection = createFailureInjection({ root, launch: { rowWrites: 1 } });
	await injection.obstruct({ step: 'row', stem: 'take' });
	expect(await readdir(root)).toEqual(['recordings']);

	await injection.release();

	expect(await readdir(root)).toEqual([]);
});
