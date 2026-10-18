/**
 * Folder Sync Tests
 *
 * `folder.sync.run()` saves the folder's edits, fetches, and brings the two
 * histories together without asking anyone anything (ADR-0576): a
 * fast-forward, a push, or one merge commit of both heads whose files are
 * one merge per changed path, this device the writer acting. These run a
 * browser folder on the in-memory OPFS stand-in over real Git smart HTTP
 * (the `git http-backend` CGI, no port), with a `git` clone producing
 * incoming history, and check every result against the bare repository with
 * `git` itself.
 *
 * Key behaviors:
 * - Independent field and body changes merge into one commit with
 *   parents [local, remote], pushed, and the merged row is in standard form
 * - Competing units go to this device; each lost unit is an `Overrode:`
 *   trailer naming the losing parent, and the lost version stays reachable
 * - A delete beats an edit it never saw, from either side
 * - A text file merges by line, a lone carriage return kept; a binary file,
 *   or bytes that are not UTF-8, both changed, are this device's whole
 * - Only the net change of each side counts: a change made and reverted
 *   between syncs does not override the other side
 * - A rename merges the other side's edit into the renamed file
 * - A row its table would refuse still merges by field: no schema takes part
 * - A push that loses a race merges again from the same local head against
 *   the new remote; it never merges its own merge, and gives up after five
 * - A push whose reply is lost still publishes, and the next Sync finds the
 *   remote already there
 * - Unrelated histories are refused unless asked for. A folder with no
 *   commit fetches before it records anything: its first commit is a root
 *   only on an empty remote, and otherwise merges its files with the
 *   remote's over an empty base onto the remote head, its one parent
 *
 * See also:
 * - `merge-file.test.ts` and `write.test.ts` for the unit merges
 * - `git/opfs-incoming.test.ts` and `sync-replay.test.ts` for a publish cut off
 *   partway, which the next Sync finishes
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
	type TestStorage,
} from './browser-storage.test-support.js';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	type SyncOutcome,
} from './contract.js';
import { REMOTE_MOVED } from './git/backend.js';
import {
	createBareRemote,
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
type Opened = Folder<typeof definition>;
const TODO = 'todos/walk.md';
const DISPLAY = 'settings/display.md';
const REMOTE = 'http://git.test/remote.git';
const decoder = new TextDecoder();

const row = (frontmatter: string[], body = '') =>
	['---', ...frontmatter, '---', body].join('\n');
const SEED = row(['title: Walk', 'done: false'], 'Left at dawn.\n');
/** The display settings row as a peer writes it. */
const display = (theme: string, size: number) =>
	row([`theme: ${theme}`, `size: ${size}`]);
/** The display settings this device reads. */
const settingsOf = async (folder: Opened) =>
	expectOk(await folder.tables.settings.get('display'))?.row.fields;

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

/**
 * One remote seeded by a browser folder with a todo and a settings row, and a
 * `git` clone of it that produces incoming history: two checkouts of the
 * same base commit. `beforePush` runs before each push request reaches the
 * remote, and `afterPush` after the remote answered it; either may throw.
 */
async function setup() {
	const root = await scratch('folder-sync-');
	const bare = await createBareRemote(root);
	const served = await gitHttpFetch(root);
	const hooks: {
		beforePush?: () => Promise<void>;
		afterPush?: () => Promise<void>;
		afterFetch?: () => Promise<void>;
	} = {};
	const httpFetch = (async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const pushing = url.endsWith('/git-receive-pack');
		if (pushing) await hooks.beforePush?.();
		const response = await served(input, init);
		const after = pushing
			? hooks.afterPush
			: url.endsWith('/git-upload-pack')
				? hooks.afterFetch
				: undefined;
		if (after !== undefined) {
			await response.clone().arrayBuffer();
			await after();
		}
		return response;
	}) as typeof fetch;
	const local = expectOk(
		await openFolder({
			app: 'so.epicenter.synctest',
			definition,
			browser: {
				author: { name: 'Local', email: 'local@example.test' },
				httpFetch,
				...browserStorage(createTestStorage()),
			},
		}),
	);
	opened.push(local);
	expectOk(await local.write(TODO, null, SEED));
	expectOk(
		await local.tables.settings.create(
			{ fields: { theme: 'light', size: 1 }, body: '' },
			{ stem: 'display' },
		),
	);
	// Connecting a folder with files to an empty remote sends them.
	synced(expectOk(await local.sync.connect(REMOTE)));
	const peer = join(root, 'peer');
	await git(root, 'clone', '--quiet', bare, peer);
	return {
		local,
		hooks,
		httpFetch,
		remoteHead: () => git(bare, 'rev-parse', 'main'),
		/** `[commit, ...parents]` of the remote branch head. */
		remoteParents: async () =>
			(await git(bare, 'rev-list', '--parents', '-n', '1', 'main')).split(' '),
		remoteFile: (path: string, ref = 'main') =>
			git(bare, 'show', `${ref}:${path}`),
		remoteMessage: () => git(bare, 'log', '-1', '--format=%B', 'main'),
		/** The tree of the remote branch head. */
		remoteTree: () => git(bare, 'rev-parse', 'main^{tree}'),
		/** The commits of the remote branch with no parent. */
		roots: () => git(bare, 'rev-list', '--max-parents=0', 'main'),
		/** The peer writes `files` (`null` removes one), commits, and pushes. */
		async incoming(files: Record<string, string | Uint8Array | null>) {
			await git(peer, 'pull', '--quiet', '--ff-only');
			for (const [path, content] of Object.entries(files)) {
				if (content === null) {
					await rm(join(peer, path));
					await git(peer, 'rm', '--quiet', '--cached', '--', path);
					continue;
				}
				await mkdir(dirname(join(peer, path)), { recursive: true });
				await writeFile(join(peer, path), content);
				await git(peer, 'add', '--', path);
			}
			await git(peer, 'commit', '--quiet', '-m', 'Peer edit');
			await git(peer, 'push', '--quiet', 'origin', 'main');
			return git(bare, 'rev-parse', 'main');
		},
	};
}

function synced(result: SyncOutcome): string {
	if (result.kind !== 'synced')
		throw new Error(`Expected synced, got ${JSON.stringify(result)}`);
	return result.head;
}

/** The local head before Sync, as Save version leaves it. */
async function saved(folder: Opened): Promise<string> {
	const outcome = await folder.git.commit();
	if (outcome.status !== 'committed')
		throw new Error(`Expected a commit, got ${outcome.status}`);
	return outcome.oid;
}

async function text(folder: Opened, path: string) {
	return decoder.decode(expectOk(await folder.files.read(path)).bytes);
}

test('independent changes merge into one pushed commit, in the standard form', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(
		await put(
			local,
			TODO,
			row(['title: Evening walk', 'done: false'], 'Left at dawn.\n'),
		),
	);
	expectOk(await local.tables.settings.set('display', { theme: 'dark' }));
	const mine = await saved(local);
	const theirs = await context.incoming({
		[TODO]: row(
			['done: true # finished', "title: 'Walk'"],
			'Left at dawn.\nCame back by the river.\n',
		),
		[DISPLAY]: display('light', 2),
	});

	const head = synced(expectOk(await local.sync.run()));
	expect(await context.remoteHead()).toBe(head);
	expect(await context.remoteParents()).toEqual([head, mine, theirs]);
	expect(await context.remoteMessage()).not.toContain('Overrode:');
	const merged = row(
		['title: Evening walk', 'done: true'],
		'Left at dawn.\nCame back by the river.\n',
	);
	expect(await text(local, TODO)).toBe(merged);
	expect(await context.remoteFile(TODO)).toBe(merged.trimEnd());
	expect(await settingsOf(local)).toEqual({
		theme: 'dark',
		size: 2,
	});
	expect(expectOk(await local.git.status()).changes).toEqual([]);
});

test("competing units go to this device, and each lost unit names the remote's commit", async () => {
	const context = await setup();
	const { local } = context;
	const mine = row(['title: Mine', 'done: false'], 'Left at noon.\n');
	expectOk(await put(local, TODO, mine));
	expectOk(await local.tables.settings.set('display', { theme: 'dark' }));
	const theirs = await context.incoming({
		[TODO]: row(['title: Theirs', 'done: true'], 'Left at dusk.\n'),
		[DISPLAY]: display('sepia', 1),
	});

	synced(expectOk(await local.sync.run()));
	expect(await text(local, TODO)).toBe(
		row(['title: Mine', 'done: true'], 'Left at noon.\n'),
	);
	expect(await settingsOf(local)).toEqual({
		theme: 'dark',
		size: 1,
	});
	const message = await context.remoteMessage();
	expect(message).toContain(`Overrode: ${theirs} field="title" "${TODO}"`);
	expect(message).toMatch(
		new RegExp(`Overrode: ${theirs} lines=body:\\d+\\+\\d+ "${TODO}"`),
	);
	expect(message).toContain(`Overrode: ${theirs} field="theme" "${DISPLAY}"`);
	// What lost is still in history, as the merge's second parent.
	expect(await context.remoteFile(TODO, theirs)).toContain('Theirs');
});

test('a delete beats an edit it never saw, from either side', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(await local.write('notes.txt', null, 'one\n'));
	synced(expectOk(await local.sync.run()));

	// This device deletes; the remote edits.
	expectOk(await local.tables.todos.delete('walk'));
	const edited = await context.incoming({
		[TODO]: row(['title: Walk', 'done: true'], 'Left at dawn.\n'),
	});
	synced(expectOk(await local.sync.run()));
	expect(expectOk(await local.tables.todos.get('walk'))).toBeUndefined();
	expect(await context.remoteMessage()).toContain(
		`Overrode: ${edited} file "${TODO}"`,
	);
	expect(await context.remoteFile(TODO, edited)).toContain('done: true');

	// The remote deletes; this device edits.
	expectOk(await put(local, 'notes.txt', 'one\ntwo\n'));
	const editedHere = await saved(local);
	await context.incoming({ 'notes.txt': null });
	synced(expectOk(await local.sync.run()));
	expect(expectErr(await local.files.read('notes.txt')).name).toBe('NotFound');
	expect(await context.remoteMessage()).toContain(
		`Overrode: ${editedHere} file "notes.txt"`,
	);
	expect(await context.remoteFile('notes.txt', editedHere)).toBe('one\ntwo');
});

test('a text file merges by line, and a binary file both changed is this device’s', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(await local.write('README.md', null, 'one\ntwo\nthree\n'));
	expectOk(await local.write('photo.bin', null, new Uint8Array([0, 1, 2])));
	synced(expectOk(await local.sync.run()));

	expectOk(await put(local, 'README.md', 'ONE\ntwo\nthree\n'));
	const mine = new Uint8Array([0, 9, 9]);
	expectOk(await put(local, 'photo.bin', mine));
	const theirs = await context.incoming({
		'README.md': 'one\ntwo\nTHREE\n',
		'photo.bin': new Uint8Array([7, 7, 7]),
	});
	synced(expectOk(await local.sync.run()));
	expect(await text(local, 'README.md')).toBe('ONE\ntwo\nTHREE\n');
	expect(expectOk(await local.files.read('photo.bin')).bytes).toEqual(mine);
	expect(await context.remoteMessage()).toContain(
		`Overrode: ${theirs} file "photo.bin"`,
	);
});

test('bytes stay exact: a lone carriage return merges by line, and invalid UTF-8 both changed is this device’s whole', async () => {
	const context = await setup();
	const { local } = context;
	const base = {
		'lone-cr.txt': 'one\rtwo\nthree\n',
		'latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x0a]),
	};
	for (const [path, bytes] of Object.entries(base))
		expectOk(await local.write(path, null, bytes));
	synced(expectOk(await local.sync.run()));

	const mine = {
		'lone-cr.txt': 'ONE\rtwo\nthree\n',
		'latin1.txt': new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x0a, 0x0a]),
	};
	for (const [path, bytes] of Object.entries(mine))
		expectOk(await put(local, path, bytes));
	await context.incoming({
		'lone-cr.txt': 'one\rtwo\nTHREE\n',
		'latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x21]),
	});

	synced(expectOk(await local.sync.run()));
	expect(await text(local, 'lone-cr.txt')).toBe('ONE\rtwo\nTHREE\n');
	expect(expectOk(await local.files.read('latin1.txt')).bytes).toEqual(
		mine['latin1.txt'],
	);
});

test('a change made and reverted between syncs does not override the other side', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(
		await put(
			local,
			TODO,
			row(['title: Run', 'done: false'], 'Left at dawn.\n'),
		),
	);
	await saved(local);
	expectOk(await put(local, TODO, SEED));
	await saved(local);
	await context.incoming({
		[TODO]: row(['title: Peer walk', 'done: false'], 'Left at dawn.\n'),
	});

	synced(expectOk(await local.sync.run()));
	expect(expectOk(await local.tables.todos.get('walk'))?.row.fields.title).toBe(
		'Peer walk',
	);
	expect(await context.remoteMessage()).not.toContain('Overrode:');
});

test("a rename merges the other side's edit into the renamed file", async () => {
	const context = await setup();
	const { local } = context;
	expectOk(await local.tables.todos.rename('walk', 'stroll'));
	await context.incoming({
		[TODO]: row(['title: Walk', 'done: true'], 'Left at dawn.\n'),
	});

	synced(expectOk(await local.sync.run()));
	expect(expectOk(await local.tables.todos.get('walk'))).toBeUndefined();
	expect(expectOk(await local.tables.todos.get('stroll'))?.row.fields).toEqual({
		title: 'Walk',
		done: true,
	});
	expect(await context.remoteFile('todos/stroll.md')).toContain('done: true');
});

test('a row its table would refuse still merges by field', async () => {
	const context = await setup();
	const { local } = context;
	// `done` is not a boolean on either side; the merge reads no schema.
	const mine = row(
		['title: Walk', 'done: maybe', 'note: mine'],
		'Left at dawn.\n',
	);
	expectOk(await put(local, TODO, mine));
	const theirs = await context.incoming({
		[TODO]: row(
			['title: Walk', 'done: maybe', 'note: theirs'],
			'Left at dawn.\n',
		),
	});

	synced(expectOk(await local.sync.run()));
	expect(await text(local, TODO)).toBe(mine);
	expect(await context.remoteMessage()).toContain(
		`Overrode: ${theirs} field="note" "${TODO}"`,
	);
});

test('a merge that would hold two paths only their case tells apart is not sent', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(await put(local, 'Notes.md', 'mine\n'));
	const theirs = await context.incoming({ 'notes.md': 'theirs\n' });

	const refused = expectErr(await local.sync.run());
	expect(refused).toMatchObject({
		name: 'Unrepresentable',
		whose: 'folder',
		paths: ['Notes.md', 'notes.md'],
	});
	expect(refused.message).toContain("'Notes.md', 'notes.md'");
	expect(await context.remoteHead()).toBe(theirs);
	expect(await text(local, 'Notes.md')).toBe('mine\n');
});

test("a refused push is a lost race in old and new Git's wording, and nothing else", () => {
	for (const reason of [
		'non-fast-forward',
		'fetch first',
		'failed to update ref',
		"cannot lock ref 'refs/heads/main': is at 1234 but expected 5678",
		'incorrect old value provided',
		'reference already exists',
		'reference does not exist',
	])
		expect([reason, REMOTE_MOVED.test(reason)]).toEqual([reason, true]);
	for (const reason of [
		'pre-receive hook declined',
		'protected branch hook declined',
		'unpacker error',
		'Authentication failed',
	])
		expect([reason, REMOTE_MOVED.test(reason)]).toEqual([reason, false]);
});

test('a row renamed while Sync fetches keeps the edit the remote made to it', async () => {
	const context = await setup();
	const { local, hooks } = context;
	await context.incoming({
		[TODO]: row(['title: Walk', 'done: true'], 'Left at dawn.\n'),
	});
	// After the checkpoint, before the publish reaches the row.
	hooks.afterFetch = async () => {
		hooks.afterFetch = undefined;
		expectOk(await local.tables.todos.rename('walk', 'stroll'));
	};

	synced(expectOk(await local.sync.run()));
	expect(await text(local, 'todos/stroll.md')).toContain('done: true');
	expect(await context.remoteFile('todos/stroll.md')).toContain('done: true');
});

test('a row renamed after Sync pushed its merge keeps the edit the remote made to it', async () => {
	const context = await setup();
	const { local, hooks } = context;
	expectOk(await put(local, 'other.txt', 'mine\n'));
	await context.incoming({
		[TODO]: row(['title: Walk', 'done: true'], 'Left at dawn.\n'),
	});
	hooks.afterPush = async () => {
		hooks.afterPush = undefined;
		expectOk(await local.tables.todos.rename('walk', 'stroll'));
	};

	synced(expectOk(await local.sync.run()));
	expect(await text(local, 'todos/stroll.md')).toContain('done: true');
	expect(await context.remoteFile('todos/stroll.md')).toContain('done: true');
});

test('a file made while Sync fetches, where the remote adds one, merges with it in the same Sync', async () => {
	const context = await setup();
	const { local, hooks } = context;
	await context.incoming({ 'notes/new.md': 'theirs\n' });
	hooks.afterFetch = async () => {
		hooks.afterFetch = undefined;
		expectOk(await local.write('notes/new.md', null, 'mine\n'));
	};

	synced(expectOk(await local.sync.run()));
	const merged = await text(local, 'notes/new.md');
	expect(merged).toContain('mine\n');
	expect(merged).toContain('theirs\n');
	expect(await context.remoteFile('notes/new.md')).toBe(merged!.trimEnd());
});

test('a push that lost a race merges again from the same local head', async () => {
	const context = await setup();
	const { local, hooks } = context;
	expectOk(await local.tables.settings.set('display', { theme: 'dark' }));
	const mine = await saved(local);
	await context.incoming({ [DISPLAY]: display('light', 2) });
	let raced: string | undefined;
	hooks.beforePush = async () => {
		hooks.beforePush = undefined;
		raced = await context.incoming({
			[DISPLAY]: display('light', 3),
		});
	};

	const head = synced(expectOk(await local.sync.run()));
	// One merge of this device's head and the remote that won the race.
	expect(await context.remoteParents()).toEqual([head, mine, raced!]);
	expect(await settingsOf(local)).toEqual({
		theme: 'dark',
		size: 3,
	});
});

test('a remote that keeps moving stops Sync after five attempts, with nothing published', async () => {
	const context = await setup();
	const { local, hooks } = context;
	expectOk(await local.tables.settings.set('display', { theme: 'dark' }));
	const mine = await saved(local);
	await context.incoming({ [DISPLAY]: display('light', 2) });
	let size = 2;
	hooks.beforePush = async () => {
		size++;
		await context.incoming({
			[DISPLAY]: display('light', size),
		});
	};

	const error = expectErr(await local.sync.run());
	hooks.beforePush = undefined;
	expect(error).toMatchObject({ name: 'KeptChanging', attempts: 5 });
	expect(expectOk(await local.git.log(1))[0]?.oid).toBe(mine);
	expect((await settingsOf(local))?.size).toBe(1);
});

test('a push whose reply was lost still publishes, and the next Sync finds the remote there', async () => {
	const context = await setup();
	const { local, hooks } = context;
	expectOk(await local.tables.settings.set('display', { theme: 'dark' }));
	await context.incoming({ [DISPLAY]: display('light', 2) });
	hooks.afterPush = async () => {
		hooks.afterPush = undefined;
		throw new Error('The connection dropped');
	};

	const outcome = expectOk(await local.sync.run());
	expect(outcome).toMatchObject({
		kind: 'saved',
		push: { status: 'failed' },
	});
	const head = await context.remoteHead();
	expect(outcome.head).toBe(head);
	expect(await settingsOf(local)).toEqual({
		theme: 'dark',
		size: 2,
	});

	expect(synced(expectOk(await local.sync.run()))).toBe(head);
	expect(await context.remoteHead()).toBe(head);
});

test('only the remote changed: a fast-forward; only this device: a push', async () => {
	const context = await setup();
	const { local } = context;
	const theirs = await context.incoming({ 'notes.txt': 'From the peer\n' });
	expect(synced(expectOk(await local.sync.run()))).toBe(theirs);
	expect(await text(local, 'notes.txt')).toBe('From the peer\n');

	expectOk(await put(local, 'notes.txt', 'From here\n'));
	const head = synced(expectOk(await local.sync.run()));
	expect(await context.remoteParents()).toEqual([head, theirs]);
	expect(await context.remoteFile('notes.txt')).toBe('From here');
});

test('a folder with a commit of its own meets an unrelated remote as Unrelated until asked to combine', async () => {
	const context = await setup();
	const other = expectOk(
		await openFolder({
			app: 'so.epicenter.synctest.other',
			definition,
			browser: {
				author: { name: 'Other', email: 'other@example.test' },
				httpFetch: context.httpFetch,
				...browserStorage(createTestStorage()),
			},
		}),
	);
	opened.push(other);
	expectOk(await other.write('notes.txt', null, 'Other\n'));
	await saved(other);

	expect(expectErr(await other.sync.connect(REMOTE)).name).toBe('Unrelated');
	const head = synced(
		expectOk(await other.sync.run({ allowUnrelatedHistories: true })),
	);
	expect(await context.remoteHead()).toBe(head);
	expect(await text(other, TODO)).toBe(SEED);
	expect(await context.remoteFile('notes.txt')).toBe('Other');
});

/** A folder with no commit, syncing with the setup's remote. */
async function freshFolder(
	context: Awaited<ReturnType<typeof setup>>,
	{
		httpFetch = context.httpFetch,
		storage = createTestStorage(),
		app = `so.epicenter.synctest.fresh${fresh++}`,
	}: {
		httpFetch?: typeof fetch;
		storage?: TestStorage;
		app?: string;
	} = {},
) {
	const folder = expectOk(
		await openFolder({
			app,
			definition,
			browser: {
				author: { name: 'Fresh', email: 'fresh@example.test' },
				httpFetch,
				...browserStorage(storage),
			},
		}),
	);
	opened.push(folder);
	return folder;
}
let fresh = 0;

/** The folder's files in `storage`, `.git` aside, as text. */
function filesIn(storage: TestStorage, app: string) {
	return Object.fromEntries(
		[...opfsOf(storage).files(app)]
			.filter(([path]) => !path.startsWith('.git/'))
			.map(([path, bytes]) => [path, decoder.decode(bytes)])
			.sort(([a], [b]) => (a! < b! ? -1 : 1)),
	);
}

/**
 * A remote whose head adds a text file this folder adds too, and a file
 * where this folder has a directory's name, and a fresh folder with files
 * of its own that merge with every kind of path: one both added, a file
 * against a directory, and paths only one side has.
 */
async function firstSyncWorld(storage = createTestStorage(), app?: string) {
	const context = await setup();
	const remoteHead = await context.incoming({
		'notes.txt': 'one\ntwo\nthree\n',
		'a/b': 'remote dir file\n',
		'remote-only.md': 'remote only\n',
	});
	const folder = await freshFolder(context, { storage, app });
	expectOk(await folder.write('notes.txt', null, 'ONE\ntwo\nthree\n'));
	expectOk(await folder.write('a', null, 'local file a\n'));
	expectOk(await folder.write('mine.md', null, 'mine\n'));
	return { context, folder, remoteHead };
}

test('a first sync to an empty remote commits the folder as a root and pushes it', async () => {
	const { local, remoteParents, remoteFile } = await setup();
	const [head, ...parents] = await remoteParents();
	expect(parents).toEqual([]);
	expect(local.git.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		oid: head,
	});
	expect(await remoteFile(TODO)).toBe(SEED.trimEnd());
});

test("a first sync onto a remote's history merges the folder's files over an empty base into one commit on the remote head", async () => {
	const context = await setup();
	const before = await context.remoteHead();
	const fresh = await freshFolder(context);
	expectOk(await fresh.write('notes.txt', null, 'Fresh\n'));
	expectOk(
		await fresh.write(
			TODO,
			null,
			row(['title: Run', 'done: false'], 'Left at dawn.\n'),
		),
	);

	const head = synced(expectOk(await fresh.sync.connect(REMOTE)));
	expect(await context.remoteHead()).toBe(head);
	// One parent, the remote head: no second root enters the history.
	expect(await context.remoteParents()).toEqual([head, before]);
	expect((await context.roots()).split('\n')).toHaveLength(1);
	expect(await context.remoteFile('notes.txt')).toBe('Fresh');
	// Both added the todo: the field both set differently is this folder's,
	// and the trailer names the remote head that lost it.
	expect(await text(fresh, TODO)).toBe(
		row(['title: Run', 'done: false'], 'Left at dawn.\n'),
	);
	expect(await context.remoteMessage()).toContain(
		`Overrode: ${before} field="title" "${TODO}"`,
	);
	expect(await settingsOf(fresh)).toEqual({ theme: 'light', size: 1 });

	// The histories now share a commit, so the next sync is an ordinary one.
	const theirs = await context.incoming({ 'peer.txt': 'Peer\n' });
	expectOk(await put(fresh, 'notes.txt', 'Fresh again\n'));
	const next = synced(expectOk(await fresh.sync.run()));
	const [, ...parents] = await context.remoteParents();
	expect(parents).toHaveLength(2);
	expect(parents).toContain(theirs);
	expect(await context.remoteHead()).toBe(next);
	expect(await text(fresh, 'peer.txt')).toBe('Peer\n');
});

test('a first sync whose files the remote already holds takes the remote head as it is', async () => {
	const context = await setup();
	const before = await context.remoteHead();
	const fresh = await freshFolder(context);
	expectOk(await fresh.write(TODO, null, SEED));

	expect(synced(expectOk(await fresh.sync.connect(REMOTE)))).toBe(before);
	expect(await context.remoteHead()).toBe(before);
	expect(fresh.git.snapshot.lastCommit).toBeUndefined();
	expect(expectOk(await fresh.git.status())).toMatchObject({
		head: before,
		changes: [],
	});
});

test('a first sync whose fetch failed records nothing, so the retry still lands on the remote head', async () => {
	const context = await setup();
	const before = await context.remoteHead();
	let offline = true;
	const fresh = await freshFolder(context, {
		httpFetch: (async (input, init) => {
			if (offline) throw new TypeError('Failed to fetch');
			return context.httpFetch(input, init);
		}) as typeof fetch,
	});
	expectOk(await fresh.write('notes.txt', null, 'Fresh\n'));

	expect(expectErr(await fresh.sync.connect(REMOTE)).name).toBe('Fetch');
	expect(fresh.git.snapshot.lastCommit).toBeUndefined();
	expect(expectOk(await fresh.git.status()).head).toBeUndefined();

	offline = false;
	const head = synced(expectOk(await fresh.sync.run()));
	expect(await context.remoteParents()).toEqual([head, before]);
	expect(await context.remoteFile('notes.txt')).toBe('Fresh');
	expect(await text(fresh, TODO)).toBe(SEED);
});

test('a first sync stops where the remote adds a file this folder ignores, sending nothing', async () => {
	const context = await setup();
	const before = await context.incoming({ 'secret.txt': 'Theirs\n' });
	const fresh = await freshFolder(context);
	expectOk(await fresh.write('.gitignore', null, 'secret.txt\n'));
	expectOk(await fresh.write('secret.txt', null, 'Mine\n'));

	const { name, message } = expectErr(await fresh.sync.connect(REMOTE));
	expect(name).toBe('Blocked');
	expect(message).toContain("'secret.txt'");
	expect(await context.remoteHead()).toBe(before);
	expect(await text(fresh, 'secret.txt')).toBe('Mine\n');
	expect(expectOk(await fresh.git.status()).head).toBeUndefined();
});

test('the first commit is published here before it is sent, so a file deleted during its push stays deleted and the next sync sends that', async () => {
	const { context, folder, remoteHead } = await firstSyncWorld();
	context.hooks.beforePush = async () => {
		context.hooks.beforePush = undefined;
		const current = expectOk(await folder.files.read('mine.md'));
		expectOk(await folder.write('mine.md', current.bytes, null));
	};
	const outcome = expectOk(await folder.sync.connect(REMOTE));
	expect(outcome).toMatchObject({ kind: 'saved', changedSince: true });
	const [first, ...parents] = await context.remoteParents();
	expect(parents).toEqual([remoteHead]);
	expect(await context.remoteFile('mine.md')).toBe('mine');
	expect((await folder.files.read('mine.md')).error?.name).toBe('NotFound');

	const next = synced(expectOk(await folder.sync.run()));
	expect(await context.remoteParents()).toEqual([next, first!]);
	expect(await context.remoteFile('notes.txt')).toBe(
		'one\ntwo\nthree\nONE\ntwo\nthree',
	);
	expect((await folder.files.read('mine.md')).error?.name).toBe('NotFound');
	expect((await context.roots()).split('\n')).toHaveLength(1);
});

test('an edit made while the first commit is pushed stays here, the merge is never made twice, and the next sync sends the edit', async () => {
	const { context, folder } = await firstSyncWorld();
	const merged = 'one\ntwo\nthree\nONE\ntwo\nthree\n';
	context.hooks.beforePush = async () => {
		context.hooks.beforePush = undefined;
		expectOk(await put(folder, 'notes.txt', `${merged}four\n`));
		expectOk(await put(folder, 'remote-only.md', 'made here meanwhile\n'));
	};
	expect(expectOk(await folder.sync.connect(REMOTE))).toMatchObject({
		kind: 'saved',
		changedSince: true,
	});
	expect(await context.remoteFile('notes.txt')).toBe(merged.trimEnd());
	expect(await text(folder, 'notes.txt')).toBe(`${merged}four\n`);
	expect(await text(folder, 'remote-only.md')).toBe('made here meanwhile\n');
	expect(await text(folder, 'a~local')).toBe('local file a\n');

	synced(expectOk(await folder.sync.run()));
	expect(await context.remoteFile('notes.txt')).toBe(`${merged}four`);
	expect(await context.remoteFile('remote-only.md')).toBe(
		'made here meanwhile',
	);
	expect(await context.remoteFile('a/b')).toBe('remote dir file');
	expect(await context.remoteFile('a~local')).toBe('local file a');
	expect(
		await context.remoteFile('a~local-2').catch(() => undefined),
	).toBeUndefined();
});

test('a folder closed right after its first push reopens on the commit it sent, and syncs without merging it again', async () => {
	const storage = createTestStorage();
	const app = 'so.epicenter.synctest.closed';
	const { context, folder, remoteHead } = await firstSyncWorld(storage, app);
	context.hooks.afterPush = async () => {
		context.hooks.afterPush = undefined;
		void folder.close();
	};
	const head = synced(expectOk(await folder.sync.connect(REMOTE)));
	expect(await context.remoteParents()).toEqual([head, remoteHead]);
	const before = filesIn(storage, app);

	const again = await freshFolder(context, { storage, app });
	expect(synced(expectOk(await again.sync.run()))).toBe(head);
	expect(filesIn(storage, app)).toEqual(before);
	expect(before['notes.txt']).toBe('one\ntwo\nthree\nONE\ntwo\nthree\n');
	expect(await context.remoteHead()).toBe(head);
});

test('a version saved while the first commit is recorded waits for it, and lands on it rather than as a root of its own', async () => {
	const storage = createTestStorage();
	const app = 'so.epicenter.synctest.saving';
	const { context, folder, remoteHead } = await firstSyncWorld(storage, app);
	let saving: ReturnType<typeof folder.git.commit> | undefined;
	// The first loose object the first commit writes, after the fetch's
	// pack: the capture has begun.
	opfsOf(storage).faults.open = (path) => {
		if (
			saving !== undefined ||
			!path.startsWith(`${app}/.git/objects/`) ||
			path.startsWith(`${app}/.git/objects/pack/`)
		)
			return;
		saving = folder.git.commit();
	};
	const head = synced(expectOk(await folder.sync.connect(REMOTE)));
	opfsOf(storage).faults.open = undefined;
	expect(saving).toBeDefined();
	expect((await saving!).status).toBe('unchanged');
	expect(await context.remoteParents()).toEqual([head, remoteHead]);
	expect(synced(expectOk(await folder.sync.run()))).toBe(head);
	expect((await context.roots()).split('\n')).toHaveLength(1);
});

test('a first publish cut off at any file is finished by the next sync, with the files and the remote of one that was not', async () => {
	const step = (storage: TestStorage, app: string, cut: number) => {
		let landed = 0;
		const fault = (path: string) => {
			if (!path.startsWith(`${app}/`) || path.startsWith(`${app}/.git/`))
				return undefined;
			return landed++ === cut ? ('fail' as const) : undefined;
		};
		const { faults } = opfsOf(storage);
		faults.close = fault;
		faults.move = fault;
		faults.remove = fault;
		return {
			landed: () => landed,
			uncut() {
				faults.close = undefined;
				faults.move = undefined;
				faults.remove = undefined;
			},
		};
	};
	const cleanStorage = createTestStorage();
	const clean = await firstSyncWorld(cleanStorage, 'so.epicenter.synctest.cut');
	const counted = step(cleanStorage, 'so.epicenter.synctest.cut', -1);
	synced(expectOk(await clean.folder.sync.connect(REMOTE)));
	counted.uncut();
	const files = filesIn(cleanStorage, 'so.epicenter.synctest.cut');
	const tree = await clean.context.remoteTree();
	expect(counted.landed()).toBeGreaterThan(2);

	for (let cut = 0; cut < counted.landed(); cut++) {
		const storage = createTestStorage();
		const app = `so.epicenter.synctest.cut${cut}`;
		const run = await firstSyncWorld(storage, app);
		const faults = step(storage, app, cut);
		expect(expectErr(await run.folder.sync.connect(REMOTE)).name).toBe(
			'Publish',
		);
		faults.uncut();
		expectOk(await run.folder.sync.run());
		synced(expectOk(await run.folder.sync.run()));
		expect(filesIn(storage, app)).toEqual(files);
		expect(await run.context.remoteTree()).toBe(tree);
		expect((await run.context.roots()).split('\n')).toHaveLength(1);
	}
}, 120_000);
