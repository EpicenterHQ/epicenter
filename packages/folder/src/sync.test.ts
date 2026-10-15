/**
 * Folder Sync Tests
 *
 * `folder.sync.run()` commits saved files, fetches, merges, and pushes;
 * competing settings, row fields, row bodies, and whole row files return an
 * attempt that only `folder.sync.resolve(attempt, choices)` on the same
 * folder settles. These run a browser folder on the in-memory OPFS stand-in
 * over real Git smart HTTP (the `git http-backend` CGI, no port), with a
 * `git` clone producing incoming history, and check every result against
 * the bare repository with `git` itself. Conflict IDs are opaque: tests find
 * conflicts by kind and name.
 *
 * Key behaviors:
 * - Independent setting, field, and body changes merge without choices, and
 *   a merged row is written in the standard form
 * - Competing units are captured with both versions; nothing conflicted is
 *   written, the branch stays, and nothing is sent
 * - Choices settle fields, bodies, and settings together; the merge has the
 *   captured commits as parents and keeps everything that merged
 * - A deleted row is one whole-file unit; an unreadable one merges as text,
 *   and text chosen for it is written as chosen and reads as `InvalidRow`
 *   until repaired
 * - Taking a side of a body or a text file takes the line merge with that
 *   side winning where both changed the same lines: the other side's other
 *   lines stay
 * - Invalid choices are all reported, write nothing, and keep the attempt
 * - Another run, a save, or a moved branch makes an attempt stale
 * - A folder with no history adopts the remote on its first sync
 * - A text file outside a table merges by line; competing lines are one
 *   unit. A binary file both changed is one unit, taken or removed
 *
 * See also:
 * - `merge-file.test.ts` and `kv.test.ts` for the unit merges
 * - `merge.test.ts` for `mergeIncoming`, whose publication sync reuses
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	type SyncAttempt,
	type SyncChoices,
	type SyncConflict,
	type SyncOutcome,
} from './contract.js';
import {
	createBareRemote,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';
import { put } from './put.test-support.js';

const definition = defineFolder({
	kv: { theme: field.string(), size: field.number() },
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
type Opened = Folder<typeof definition>;
const TODO = 'todos/walk.md';
const decoder = new TextDecoder();

const row = (frontmatter: string[], body = '') =>
	['---', ...frontmatter, '---', body].join('\n');
const SEED = row(['title: Walk', 'done: false'], 'Left at dawn.\n');

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

/**
 * One remote seeded by a browser folder with a todo and `kv.json`, and a
 * `git` clone of it that produces incoming history: two checkouts of the
 * same base commit.
 */
async function setup() {
	const root = await scratch('folder-sync-');
	const bare = await createBareRemote(root);
	const httpFetch = await gitHttpFetch(root);
	const local = expectOk(
		await openFolder({
			id: 'so.epicenter.synctest',
			definition,
			browser: {
				author: { name: 'Local', email: 'local@example.test' },
				httpFetch,
				...browserStorage(createTestStorage()),
			},
		}),
	);
	opened.push(local);
	expectOk(await local.files.create(TODO, SEED));
	expectOk(await local.kv.set('theme', 'light'));
	expectOk(await local.kv.set('size', 1));
	// Connecting a folder with files to an empty remote sends them.
	synced(expectOk(await local.sync.connect('http://git.test/remote.git')));
	const peer = join(root, 'peer');
	await git(root, 'clone', '--quiet', bare, peer);
	const base = await git(bare, 'rev-parse', 'main');
	return {
		base,
		local,
		httpFetch,
		remoteHead: () => git(bare, 'rev-parse', 'main'),
		/** `[commit, ...parents]` of the remote branch head. */
		remoteParents: async () =>
			(await git(bare, 'rev-list', '--parents', '-n', '1', 'main')).split(' '),
		remoteFile: (path: string) => git(bare, 'show', `main:${path}`),
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

async function attempted(folder: Opened): Promise<SyncAttempt> {
	const error = expectErr(await folder.sync.run());
	if (error.name !== 'NeedsChoices')
		throw new Error(`Expected choices, got ${error.message}`);
	return error.attempt;
}

async function text(folder: Opened, path: string) {
	return decoder.decode(expectOk(await folder.files.read(path)).bytes);
}

/** The conflict of `kind`, by its key or field name when it has one. */
function find(
	attempt: SyncAttempt,
	kind: SyncConflict['kind'],
	name?: string,
): SyncConflict {
	const found = attempt.conflicts.find(
		(conflict) =>
			conflict.kind === kind &&
			(name === undefined ||
				(conflict.kind === 'setting' && conflict.key === name) ||
				(conflict.kind === 'field' && conflict.field === name)),
	);
	if (found === undefined) throw new Error(`No ${kind} conflict ${name ?? ''}`);
	return found;
}

test('independent changes merge without choices, in the standard form', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(
		await put(
			local.files,
			TODO,
			row(['title: Evening walk', 'done: false'], 'Left at dawn.\n'),
		),
	);
	expectOk(await local.kv.set('theme', 'dark'));
	await context.incoming({
		[TODO]: row(
			['done: true # finished', "title: 'Walk'"],
			'Left at dawn.\nCame back by the river.\n',
		),
		'kv.json': '{"theme":"light","size":2}\n',
	});

	const head = synced(expectOk(await local.sync.run()));
	expect(await context.remoteHead()).toBe(head);
	const merged = row(
		['title: Evening walk', 'done: true'],
		'Left at dawn.\nCame back by the river.\n',
	);
	expect(await text(local, TODO)).toBe(merged);
	expect(await context.remoteFile(TODO)).toBe(merged.trimEnd());
	expect(expectOk(await local.kv.get())?.values).toEqual({
		theme: 'dark',
		size: 2,
	});
	expect((await context.remoteParents()).length).toBe(3);
});

test('competing units are captured, and nothing conflicted is written or sent', async () => {
	const context = await setup();
	const { local, base } = context;
	const mine = row(['title: Evening walk', 'done: true'], 'Left at six.\n');
	expectOk(await put(local.files, TODO, mine));
	expectOk(await local.kv.set('theme', 'dark'));
	const incoming = await context.incoming({
		[TODO]: row(['title: Morning walk', 'done: true'], 'Left at seven.\n'),
		'kv.json': '{"theme":"sepia","size":1}\n',
	});

	const attempt = await attempted(local);
	expect(attempt.incoming).toBe(incoming);
	expect(attempt.local).not.toBe(base);
	expect(
		attempt.conflicts.map(({ kind, path, base, local, incoming }) => ({
			kind,
			path,
			base,
			local,
			incoming,
		})),
	).toEqual([
		{
			kind: 'setting',
			path: 'kv.json',
			base: { present: true, value: 'light' },
			local: { present: true, value: 'dark' },
			incoming: { present: true, value: 'sepia' },
		},
		{
			kind: 'field',
			path: TODO,
			base: { present: true, value: 'Walk' },
			local: { present: true, value: 'Evening walk' },
			incoming: { present: true, value: 'Morning walk' },
		},
		{
			kind: 'body',
			path: TODO,
			base: { present: true, value: 'Left at dawn.\n' },
			local: { present: true, value: 'Left at six.\n' },
			incoming: { present: true, value: 'Left at seven.\n' },
		},
	]);
	expect(await text(local, TODO)).toBe(mine);
	expect((await local.git.log(1)).data?.[0]?.oid).toBe(attempt.local);
	expect(await context.remoteHead()).toBe(incoming);
});

test('choices settle every unit, and the merge keeps what merged', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(
		await put(
			local.files,
			TODO,
			row(['title: Evening walk', 'done: true'], 'Left at six.\n'),
		),
	);
	expectOk(await local.kv.set('theme', 'dark'));
	const incoming = await context.incoming({
		[TODO]: row(['title: Morning walk', 'done: false'], 'Left at seven.\n'),
		'kv.json': '{"theme":"sepia","size":3}\n',
	});
	const attempt = await attempted(local);
	const choices: Record<string, SyncChoices[string]> = {
		[find(attempt, 'setting', 'theme').id]: { kind: 'take', side: 'incoming' },
		[find(attempt, 'field', 'title').id]: {
			kind: 'replace',
			value: 'Walk at noon',
		},
		[find(attempt, 'body').id]: { kind: 'take', side: 'incoming' },
	};
	const resolving = local.sync.resolve(attempt, choices);
	// Read when resolve is called: a later edit changes nothing published.
	choices[find(attempt, 'body').id] = { kind: 'take', side: 'local' };
	const head = synced(expectOk(await resolving));

	expect(await context.remoteParents()).toEqual([
		head,
		attempt.local,
		incoming,
	]);
	const resolved = row(
		['title: Walk at noon', 'done: true'],
		'Left at seven.\n',
	);
	expect(await text(local, TODO)).toBe(resolved);
	expect(await context.remoteFile(TODO)).toBe(resolved.trimEnd());
	expect(expectOk(await local.kv.get())?.values).toEqual({
		theme: 'sepia',
		size: 3,
	});
	// Spent: the same attempt is not resolved twice.
	expect(expectErr(await local.sync.resolve(attempt, choices)).name).toBe(
		'Stale',
	);
});

test('a deleted row against an edit is one whole-file unit', async () => {
	const context = await setup();
	const { local } = context;
	const stored = expectOk(await local.tables.todos.get('walk'));
	expectOk(await local.tables.todos.delete(stored!));
	const edited = row(['title: Morning walk', 'done: false'], 'Left at dawn.\n');
	await context.incoming({ [TODO]: edited });

	const attempt = await attempted(local);
	expect(attempt.conflicts).toEqual([
		{
			id: expect.any(String),
			kind: 'file',
			binary: false,
			path: TODO,
			base: { present: true, value: SEED },
			local: { present: false },
			incoming: { present: true, value: edited },
		},
	]);
	const file = find(attempt, 'file');
	synced(
		expectOk(
			await local.sync.resolve(attempt, {
				[file.id]: { kind: 'take', side: 'local' },
			}),
		),
	);
	expect(expectOk(await local.tables.todos.get('walk'))).toBeUndefined();
});

test('an invalid row on either side merges as text, and is repaired as text', async () => {
	const context = await setup();
	const { local } = context;
	const broken = row(['title: Walk', 'done: maybe'], 'Left at dawn.\n');
	expectOk(await put(local.files, TODO, broken));
	// Their changed lines meet ours, so the lines compete.
	const theirs = row(['title: Morning walk', 'done: true'], 'Left at dawn.\n');
	await context.incoming({ [TODO]: theirs });

	const attempt = await attempted(local);
	const file = find(attempt, 'file');
	expect(file).toMatchObject({ binary: false });
	expect(file.local).toEqual({ present: true, value: broken });
	expect(file.incoming).toEqual({ present: true, value: theirs });
	const typed = row(['title: Morning walk', 'done: maybe'], 'Left at dawn.\n');
	synced(
		expectOk(
			await local.sync.resolve(attempt, {
				[file.id]: { kind: 'replace', value: typed },
			}),
		),
	);
	// Written as chosen; the table reads it as text to repair.
	expect(await text(local, TODO)).toBe(typed);
	const read = expectErr(await local.tables.todos.get('walk'));
	expect(read.name).toBe('InvalidRow');
});

test('invalid choices are all reported, write nothing, and keep the attempt', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(
		await put(
			local.files,
			TODO,
			row(['title: Evening walk', 'done: false'], 'Left at six.\n'),
		),
	);
	expectOk(await local.kv.set('size', 2));
	const incoming = await context.incoming({
		[TODO]: row(['title: Morning walk', 'done: false'], 'Left at seven.\n'),
		'kv.json': '{"theme":"light","size":3}\n',
	});
	const attempt = await attempted(local);
	const title = find(attempt, 'field', 'title');
	const body = find(attempt, 'body');
	const size = find(attempt, 'setting', 'size');

	const shapes = expectErr(
		await local.sync.resolve(attempt, {
			[title.id]: { kind: 'take', side: 'elsewhere' } as never,
			[body.id]: { kind: 'remove' },
			stray: { kind: 'remove' },
		}),
	);
	expect(shapes.name).toBe('InvalidChoices');
	if (shapes.name !== 'InvalidChoices') return;
	expect(
		shapes.problems.map(({ conflictId, reason }) => ({ conflictId, reason })),
	).toEqual([
		{ conflictId: size.id, reason: 'missing' },
		{ conflictId: title.id, reason: 'malformed' },
		{ conflictId: body.id, reason: 'disallowed' },
		{ conflictId: 'stray', reason: 'unknown' },
	]);

	const values = expectErr(
		await local.sync.resolve(attempt, {
			[title.id]: { kind: 'remove' },
			[body.id]: { kind: 'replace', value: 42 },
			[size.id]: { kind: 'replace', value: 'large' },
		}),
	);
	if (values.name !== 'InvalidChoices') throw new Error(values.message);
	expect(
		values.problems.map(({ conflictId, reason }) => ({ conflictId, reason })),
	).toEqual([
		{ conflictId: size.id, reason: 'invalid' },
		{ conflictId: body.id, reason: 'invalid' },
	]);
	const required = expectErr(
		await local.sync.resolve(attempt, {
			[title.id]: { kind: 'remove' },
			[body.id]: { kind: 'take', side: 'local' },
			[size.id]: { kind: 'take', side: 'local' },
		}),
	);
	if (required.name !== 'InvalidChoices') throw new Error(required.message);
	expect(required.problems).toEqual([
		{ conflictId: title.id, reason: 'invalid', message: 'title is missing' },
	]);
	expect(await context.remoteHead()).toBe(incoming);

	// Still current: valid choices settle it.
	synced(
		expectOk(
			await local.sync.resolve(attempt, {
				[title.id]: { kind: 'take', side: 'local' },
				[body.id]: { kind: 'replace', value: '' },
				[size.id]: { kind: 'replace', value: 5 },
			}),
		),
	);
	expect(await text(local, TODO)).toBe(
		row(['title: Evening walk', 'done: false']),
	);
});

test('another run or a later save makes an attempt stale', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(await local.kv.set('theme', 'dark'));
	await context.incoming({ 'kv.json': '{"theme":"sepia","size":1}\n' });
	const first = await attempted(local);
	const theme = find(first, 'setting', 'theme');
	const take = { [theme.id]: { kind: 'take', side: 'local' } } as const;

	const second = await attempted(local);
	const replaced = expectErr(await local.sync.resolve(first, take));
	expect(replaced).toMatchObject({ name: 'Stale', reason: 'replaced' });

	expectOk(await local.files.create('notes.txt', 'Saved while reviewing\n'));
	const changed = expectErr(
		await local.sync.resolve(second, {
			[find(second, 'setting', 'theme').id]: { kind: 'take', side: 'local' },
		}),
	);
	expect(changed).toMatchObject({ name: 'Stale', reason: 'changed' });
	expect(await text(local, 'notes.txt')).toBe('Saved while reviewing\n');

	// A fresh run commits the save and asks again.
	const third = await attempted(local);
	synced(
		expectOk(
			await local.sync.resolve(third, {
				[find(third, 'setting', 'theme').id]: {
					kind: 'take',
					side: 'local',
				},
			}),
		),
	);
	expect(await context.remoteFile('notes.txt')).toBe('Saved while reviewing');
});

test('a text file outside a table merges by line, or is one text unit when lines compete', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(await local.files.create('README.md', 'one\ntwo\nthree\n'));
	synced(expectOk(await local.sync.run()));
	await context.incoming({ 'README.md': 'one\ntwo\nTHREE\n' });
	expectOk(await put(local.files, 'README.md', 'ONE\ntwo\nthree\n'));
	synced(expectOk(await local.sync.run()));
	expect(await text(local, 'README.md')).toBe('ONE\ntwo\nTHREE\n');

	await context.incoming({ 'README.md': 'ONE\nsecond\nTHREE\n' });
	expectOk(await put(local.files, 'README.md', 'ONE\n2\nTHREE\n'));
	const attempt = await attempted(local);
	const file = find(attempt, 'file');
	expect(file).toMatchObject({
		path: 'README.md',
		binary: false,
		local: { present: true, value: 'ONE\n2\nTHREE\n' },
		incoming: { present: true, value: 'ONE\nsecond\nTHREE\n' },
	});
	expect(await text(local, 'README.md')).toBe('ONE\n2\nTHREE\n');
	synced(
		expectOk(
			await local.sync.resolve(attempt, {
				[file.id]: { kind: 'replace', value: 'ONE\ntwo, second\nTHREE\n' },
			}),
		),
	);
	expect(await context.remoteFile('README.md')).toBe('ONE\ntwo, second\nTHREE');
});

test("taking a side of a body or a text file keeps the other side's lines that did not compete", async () => {
	const context = await setup();
	const { local } = context;
	const BASE = 'one\ntwo\nthree\nfour\n';
	expectOk(await local.files.create('README.md', BASE));
	expectOk(
		await put(local.files, TODO, row(['title: Walk', 'done: false'], BASE)),
	);
	synced(expectOk(await local.sync.run()));
	// Each side changes one line of its own and the same third line.
	const ours = 'ONE (ours)\ntwo\nthree\nFOUR (ours)\n';
	const theirs = 'one\nTWO (theirs)\nthree\nFOUR (theirs)\n';
	await context.incoming({
		'README.md': theirs,
		[TODO]: row(['title: Walk', 'done: false'], theirs),
	});
	expectOk(await put(local.files, 'README.md', ours));
	expectOk(
		await put(local.files, TODO, row(['title: Walk', 'done: false'], ours)),
	);

	const attempt = await attempted(local);
	const file = find(attempt, 'file');
	const body = find(attempt, 'body');
	const merged = {
		local: 'ONE (ours)\nTWO (theirs)\nthree\nFOUR (ours)\n',
		incoming: 'ONE (ours)\nTWO (theirs)\nthree\nFOUR (theirs)\n',
	};
	for (const conflict of [file, body])
		expect(conflict).toMatchObject({
			local: { present: true, value: merged.local },
			incoming: { present: true, value: merged.incoming },
		});
	synced(
		expectOk(
			await local.sync.resolve(attempt, {
				[file.id]: { kind: 'take', side: 'incoming' },
				[body.id]: { kind: 'take', side: 'incoming' },
			}),
		),
	);
	// "Take incoming" kept our first line.
	expect(await text(local, 'README.md')).toBe(merged.incoming);
	expect(await text(local, TODO)).toBe(
		row(['title: Walk', 'done: false'], merged.incoming),
	);
});

test('a binary file both changed is one unit, taken or removed but never replaced', async () => {
	const context = await setup();
	const { local } = context;
	expectOk(await local.files.create('photo.bin', new Uint8Array([0, 1, 2])));
	synced(expectOk(await local.sync.run()));
	const theirs = new Uint8Array([0, 7, 7]);
	await context.incoming({ 'photo.bin': theirs });
	expectOk(await put(local.files, 'photo.bin', new Uint8Array([0, 9, 9])));

	const attempt = await attempted(local);
	const file = find(attempt, 'file');
	expect(file).toMatchObject({
		path: 'photo.bin',
		binary: true,
		base: { present: true, value: new Uint8Array([0, 1, 2]) },
		local: { present: true, value: new Uint8Array([0, 9, 9]) },
		incoming: { present: true, value: theirs },
	});
	const replaced = expectErr(
		await local.sync.resolve(attempt, {
			[file.id]: { kind: 'replace', value: 'text' },
		}),
	);
	if (replaced.name !== 'InvalidChoices') throw new Error(replaced.message);
	expect(replaced.problems).toMatchObject([
		{ conflictId: file.id, reason: 'disallowed' },
	]);
	synced(
		expectOk(
			await local.sync.resolve(attempt, {
				[file.id]: { kind: 'take', side: 'incoming' },
			}),
		),
	);
	expect(expectOk(await local.files.read('photo.bin')).bytes).toEqual(theirs);
});

test('a folder with no history adopts the remote on its first sync, merging over an empty base', async () => {
	const context = await setup();
	const fresh = expectOk(
		await openFolder({
			id: 'so.epicenter.synctest.fresh',
			definition,
			browser: {
				author: { name: 'Fresh', email: 'fresh@example.test' },
				httpFetch: context.httpFetch,
				...browserStorage(createTestStorage()),
			},
		}),
	);
	opened.push(fresh);
	expectOk(await fresh.files.create('notes.txt', 'Fresh\n'));

	const head = synced(
		expectOk(await fresh.sync.connect('http://git.test/remote.git')),
	);
	expect(await context.remoteHead()).toBe(head);
	expect((await context.remoteParents()).length).toBe(3);
	expect(await text(fresh, TODO)).toBe(SEED);
	expect(await context.remoteFile('notes.txt')).toBe('Fresh');
});
