/**
 * Sync Publish Replay Tests
 *
 * Sync pushes its merge before it writes any file here, and writes each file
 * whole, with no journal (ADR-0576, ADR-0545). So a publish cut off after any
 * number of its changes leaves each file at its old bytes or its new ones,
 * and the next Sync records what is there and merges it with the commit it
 * already sent. These cut a publish after each of its changes in turn, over
 * every kind a folder merges: rows by field, text by line, bytes whole, a
 * removal, a file becoming a directory and the reverse, a new file and a new
 * row. Each must end exactly where an uninterrupted Sync ends, here and on
 * the remote.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	type TestStorage,
} from './browser-storage.test-support.js';
import { defineFolder, defineTable, field } from './contract.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';
import { put } from './put.test-support.js';

const definition = defineFolder({
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
		settings: defineTable({
			fields: {
				theme: field.optional(field.string()),
				size: field.optional(field.number()),
			},
		}),
	},
});
const ID = 'so.epicenter.replay';
const REMOTE = 'http://git.test/remote.git';
const decoder = new TextDecoder();
const row = (frontmatter: string[], body = '') =>
	['---', ...frontmatter, '---', body].join('\n');

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

/**
 * A folder and a peer at one base, each with its changes made: the peer's
 * pushed, this folder's saved and not yet synced.
 */
async function diverged() {
	const root = await scratch('sync-replay-');
	const bare = await createBareRemote(root);
	const storage: TestStorage = createTestStorage();
	/** Runs once a push has reached the remote, before Sync writes a file here. */
	const hooks: { afterPush?: () => Promise<void> } = {};
	const served = await gitHttpFetch(root);
	const httpFetch = (async (input, init) => {
		const response = await served(input, init);
		if (
			String(input instanceof Request ? input.url : input).endsWith(
				'/git-receive-pack',
			)
		) {
			const after = hooks.afterPush;
			hooks.afterPush = undefined;
			await response.clone().arrayBuffer();
			await after?.();
		}
		return response;
	}) as typeof fetch;
	const folder = expectOk(
		await openFolder({
			id: ID,
			definition,
			browser: {
				author: { name: 'Local', email: 'local@example.test' },
				httpFetch,
				...browserStorage(storage),
			},
		}),
	);
	opened.push(folder);
	const files = folder.files;
	expectOk(
		await files.create(
			'todos/walk.md',
			row(['title: Walk', 'done: false'], 'Left at dawn.\n'),
		),
	);
	expectOk(
		await folder.tables.settings.create(
			{ fields: { theme: 'light', size: 1 }, body: '' },
			{ stem: 'display' },
		),
	);
	expectOk(await files.create('notes.txt', 'one\ntwo\nthree\n'));
	expectOk(await files.create('photo.bin', new Uint8Array([0, 1, 2])));
	expectOk(await files.create('gone.txt', 'gone\n'));
	expectOk(await files.create('a', 'a file\n'));
	expectOk(await files.create('d/x', 'x\n'));
	expectOk(await files.create('keep.md', 'keep\n'));
	expect(expectOk(await folder.sync.connect(REMOTE)).kind).toBe('synced');

	const peer = join(root, 'peer');
	await git(root, 'clone', '--quiet', bare, peer);
	const peerFiles: Record<string, string | Uint8Array | null> = {
		'todos/walk.md': row(['title: Walk', 'done: true'], 'Left at dawn.\n'),
		'settings/display.md': row(['theme: light', 'size: 2']),
		'notes.txt': 'one\ntwo\nTHREE\n',
		'photo.bin': new Uint8Array([7, 7, 7]),
		'gone.txt': null,
		a: null,
		'a/b': 'now a directory\n',
		'd/x': null,
		d: 'now a file\n',
		'new.md': 'new\n',
		'todos/run.md': row(['title: Run', 'done: false']),
	};
	for (const [path, content] of Object.entries(peerFiles)) {
		if (content === null) {
			await git(peer, 'rm', '--quiet', '--', path);
			continue;
		}
		await mkdir(dirname(join(peer, path)), { recursive: true });
		await writeFile(join(peer, path), content);
		await git(peer, 'add', '--', path);
	}
	await git(peer, 'commit', '--quiet', '-m', 'Peer');
	await git(peer, 'push', '--quiet', 'origin', 'main');

	expectOk(
		await put(
			files,
			'todos/walk.md',
			row(['title: Evening walk', 'done: false'], 'Left at dawn.\n'),
		),
	);
	expectOk(await folder.tables.settings.set('display', { theme: 'dark' }));
	expectOk(await put(files, 'notes.txt', 'ONE\ntwo\nthree\n'));
	expectOk(await put(files, 'keep.md', 'kept here\n'));
	return { folder, storage, bare, hooks };
}

/** The folder's files as text, `.git` aside. */
function filesOf(storage: TestStorage) {
	return Object.fromEntries(
		[...storage.opfs.files(ID)]
			.filter(([path]) => !path.startsWith('.git/'))
			.map(([path, bytes]) => [path, decoder.decode(bytes)])
			.sort(([a], [b]) => (a! < b! ? -1 : 1)),
	);
}

/** The remote branch's files as text. */
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

const ofFolder = (path: string) =>
	path.startsWith(`${ID}/`) && !path.startsWith(`${ID}/.git/`);

/**
 * Count each change to the folder's files as it lands (a stream that
 * replaces a file closing, a new file moving into place, an entry removed),
 * and fail the one after `cut` of them, as a crash there would leave it.
 */
function cutAfter(storage: TestStorage, cut: number) {
	let landed = 0;
	const step = (path: string) => {
		if (!ofFolder(path)) return undefined;
		if (landed++ === cut) return 'fail' as const;
		return undefined;
	};
	storage.opfs.faults.close = step;
	storage.opfs.faults.move = step;
	storage.opfs.faults.remove = step;
	return () => landed;
}

function uncut(storage: TestStorage) {
	storage.opfs.faults.close = undefined;
	storage.opfs.faults.move = undefined;
	storage.opfs.faults.remove = undefined;
}

test('a publish cut off after any of its changes ends where an uninterrupted one does, on every kind', async () => {
	// The uninterrupted Sync, counting the changes its publish makes.
	const clean = await diverged();
	const counted = cutAfter(clean.storage, Number.POSITIVE_INFINITY);
	expect(expectOk(await clean.folder.sync.run()).kind).toBe('synced');
	const changes = counted();
	uncut(clean.storage);
	const expected = filesOf(clean.storage);
	const expectedRemote = await remoteFiles(clean.bare);
	expect(expected).toMatchObject({
		'todos/walk.md': row(
			['title: Evening walk', 'done: true'],
			'Left at dawn.\n',
		),
		'notes.txt': 'ONE\ntwo\nTHREE\n',
		d: 'now a file\n',
		'a/b': 'now a directory\n',
		'new.md': 'new\n',
		'keep.md': 'kept here\n',
	});
	expect(expected['gone.txt']).toBeUndefined();
	expect(expected['settings/display.md']).toBe(row(['theme: dark', 'size: 2']));
	expect(changes).toBeGreaterThan(8);
	for (const each of opened.splice(0)) await each.close();

	for (let cut = 0; cut < changes; cut++) {
		const run = await diverged();
		cutAfter(run.storage, cut);
		const first = await run.folder.sync.run();
		uncut(run.storage);
		// Nothing is ever empty or half written along the way.
		for (const [path, text] of Object.entries(filesOf(run.storage)))
			expect([cut, path, text === '']).toEqual([cut, path, false]);
		const second = await run.folder.sync.run();
		expect([
			cut,
			first.error?.name ?? first.data?.kind,
			second.data?.kind,
		]).toEqual([cut, expect.anything(), 'synced']);
		expect([cut, filesOf(run.storage)]).toEqual([cut, expected]);
		expect([cut, await remoteFiles(run.bare)]).toEqual([cut, expectedRemote]);
		expect([cut, expectOk(await run.folder.git.status()).changes]).toEqual([
			cut,
			[],
		]);
		for (const each of opened.splice(0)) await each.close();
	}
}, 120_000);

test('an edit saved during Sync to a file the remote removes is recorded, then loses to the removal, and stays in history', async () => {
	const run = await diverged();
	// The save lands after Sync's checkpoint, while its merge is being sent.
	run.hooks.afterPush = async () => {
		expectOk(await put(run.folder.files, 'gone.txt', 'edited during Sync\n'));
	};
	expect(expectOk(await run.folder.sync.run()).kind).toBe('synced');
	expect(filesOf(run.storage)['gone.txt']).toBeUndefined();
	// Sync recorded the edit and merged again: the last merge names it as
	// lost to the removal, and its commit holds the text.
	const message = await git(run.bare, 'log', '-1', '--format=%B', 'main');
	const [, recorded] =
		message.match(/Overrode: ([0-9a-f]+) file "gone.txt"/) ?? [];
	expect(recorded).toBeDefined();
	const shown = Bun.spawn(['git', 'show', `${recorded}:gone.txt`], {
		cwd: run.bare,
		env: GIT_ENV,
		stdout: 'pipe',
	});
	expect(await new Response(shown.stdout).text()).toBe('edited during Sync\n');
	expect(expectOk(await run.folder.git.status()).changes).toEqual([]);
});

test('a file of this folder in the way stops Sync before its merge is sent', async () => {
	const run = await diverged();
	const before = await git(run.bare, 'rev-parse', 'main');
	// An ignored file never committed, where the remote adds `new.md`.
	run.storage.opfs.put(
		`${ID}/.gitignore`,
		new TextEncoder().encode('new.md\n'),
	);
	expectOk(await put(run.folder.files, 'new.md', 'mine, ignored\n'));
	const refused = await run.folder.sync.run();
	expect(refused.error?.name).toBe('Blocked');
	expect(refused.error?.message).toContain("'new.md'");
	// Nothing was sent.
	expect(await git(run.bare, 'rev-parse', 'main')).toBe(before);
	expect(filesOf(run.storage)['new.md']).toBe('mine, ignored\n');
});
