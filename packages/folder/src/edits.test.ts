/**
 * Folder Editor Tests
 *
 * Drives `folder.files.edit(path)` over an engine whose reads, writes and
 * deletes a test can hold, release, or fail one at a time, so each async
 * sequence the editor contract names runs in an exact order. One case runs
 * the same editor over the real browser engine on an in-memory IndexedDB.
 *
 * Key behaviors:
 * - Acquisition is passive and stable per path and schema, over one source;
 *   snapshots are pure, cached and frozen
 * - Subscribing emits the current snapshot at once and starts the first
 *   read; text is held after unsubscribing, deletion, binary replacement
 *   and failed reads, each reported as the latest `loadError`
 * - Input is accepted before the first read; only accepted input saves
 *   automatically; observations never write
 * - Every write and delete of a path runs in call order and reports its own
 *   outcome; a publication acknowledges only the intent it captured, by
 *   identity, never by equal text
 * - A delete defers an unsubmitted automatic save, consumes only its
 *   captured intent on success, and never makes an acknowledged intent
 *   dirty again on failure
 * - A save failure survives typing until a success or discard; discard
 *   drops input without writing, and a late failure cannot reattach
 * - Reads wait for admitted writes, and read again when overtaken
 * - Close refuses input, submits held input once, answers recoveries, and
 *   waits for admitted actions
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { Type } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import type { EditorSnapshot } from './edits.js';
import type { FolderChange } from './folder.js';
import { type FolderEngine, folderHandle } from './handle.js';
import { ReadError, SaveError } from './shared/errors.js';
import { readRow } from './shared/row.js';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) =>
	new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let queued continuations and zero-delay timers run. */
const flush = async () => {
	for (let turn = 0; turn < 5; turn++) await sleep(0);
};

const notes = Type.Object({ title: Type.String() });

type Kind = 'read' | 'write' | 'delete' | 'list' | 'get';

/** One held engine call: wait until it is reached, then let it go on or fail it. */
type Hold = {
	readonly reached: Promise<void>;
	proceed(): void;
	fail(): void;
};

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * An in-memory engine. `hold(kind)` holds the next call of that kind; a
 * read takes its bytes before it waits, as a read that started then would.
 */
function fakeEngine(files: Record<string, string | Uint8Array> = {}) {
	const disk = new Map<string, Uint8Array>(
		Object.entries(files).map(([path, content]) => [
			path,
			typeof content === 'string' ? encode(content) : content,
		]),
	);
	const listeners = new Set<(change: FolderChange) => void>();
	const log: string[] = [];
	/** How often anything decoded a blob a read answered. */
	const decoded = { count: 0 };
	const blobOf = (bytes: Uint8Array) => {
		const blob = new Blob([bytes.slice()]);
		const arrayBuffer = blob.arrayBuffer.bind(blob);
		blob.arrayBuffer = () => {
			decoded.count++;
			return arrayBuffer();
		};
		return blob;
	};
	const holds: Record<
		Kind,
		(Hold & { wait: Promise<boolean>; arrive(): void })[]
	> = {
		read: [],
		write: [],
		delete: [],
		list: [],
		get: [],
	};
	/** The rows of `notes` as stored now. */
	const rows = () =>
		[...disk]
			.filter(([path]) => /^notes\/[^/]+\.md$/.test(path))
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([path, bytes]) => readRow(path.slice(6, -3), bytes, notes));
	function hold(kind: Kind): Hold {
		const reached = Promise.withResolvers<void>();
		const outcome = Promise.withResolvers<boolean>();
		const held = {
			reached: reached.promise,
			arrive: () => reached.resolve(),
			wait: outcome.promise,
			proceed: () => outcome.resolve(true),
			fail: () => outcome.resolve(false),
		};
		holds[kind].push(held);
		return held;
	}
	/** Whether the call goes on: `false` when the test failed it. */
	async function gate(kind: Kind) {
		const held = holds[kind].shift();
		if (held === undefined) return true;
		held.arrive();
		return held.wait;
	}
	const emit = (change: FolderChange) => {
		for (const listener of [...listeners]) listener(change);
	};
	const engine: FolderEngine = {
		files: {
			async list() {
				return Ok([...disk.keys()].sort());
			},
			async read(path) {
				log.push(`read ${path}`);
				const bytes = disk.get(path);
				if (!(await gate('read')))
					return ReadError.StorageFailed({ cause: new Error('disk gone') });
				return Ok(
					bytes === undefined ? undefined : { path, content: blobOf(bytes) },
				);
			},
			async write(path, content) {
				if (!(await gate('write')))
					return SaveError.StorageFailed({ cause: new Error('disk full') });
				const bytes = typeof content === 'string' ? encode(content) : content;
				disk.set(path, bytes.slice());
				log.push(`write ${path} ${decode(bytes)}`);
				emit({ paths: [path], origin: 'this-handle' });
				return Ok(undefined);
			},
			async delete(path) {
				if (!(await gate('delete')))
					return SaveError.StorageFailed({ cause: new Error('disk busy') });
				disk.delete(path);
				log.push(`delete ${path}`);
				emit({ paths: [path], origin: 'this-handle' });
				return Ok(undefined);
			},
		},
		tables: {
			notes: {
				// Rows are taken when the call starts, as a scan that started then would.
				async list() {
					log.push('list notes');
					const found = rows();
					if (!(await gate('list')))
						return ReadError.StorageFailed({ cause: new Error('disk gone') });
					return Ok(found);
				},
				async get(id) {
					log.push(`get notes/${id}.md`);
					const found = rows().find((row) => row.id === id);
					if (!(await gate('get')))
						return ReadError.StorageFailed({ cause: new Error('disk gone') });
					return Ok(found);
				},
			},
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() {
			listeners.clear();
		},
	};
	return {
		engine,
		disk,
		log,
		decoded,
		hold,
		emit,
		/** Another program changed `path`, and a watcher reported it. */
		outside(path: string, content: string | Uint8Array | null) {
			if (content === null) disk.delete(path);
			else
				disk.set(path, typeof content === 'string' ? encode(content) : content);
			emit({ paths: [path], origin: 'other-handle' });
		},
		text: (path: string) => {
			const bytes = disk.get(path);
			return bytes === undefined ? undefined : decode(bytes);
		},
		writes: () =>
			log.filter(
				(entry) => entry.startsWith('write ') || entry.startsWith('delete '),
			),
		reads: () => log.filter((entry) => entry.startsWith('read ')),
	};
}

function setup(
	files: Record<string, string | Uint8Array> = {},
	saveAfterMs = 60_000,
) {
	const fake = fakeEngine(files);
	const folder = folderHandle(fake.engine, { notes }, { saveAfterMs });
	cleanup.push(() => folder.close());
	return { ...fake, folder };
}

/** Every snapshot `edit` reports to one subscriber, the first one included. */
function record<T>(edit: {
	subscribe(listener: (snapshot: T) => void): () => void;
}) {
	const seen: T[] = [];
	const stop = edit.subscribe((snapshot) => seen.push(snapshot));
	return { seen, stop };
}

test('acquisition is passive and stable, and snapshots are pure, cached and frozen', async () => {
	const { folder, log } = setup({ 'notes/a.md': '---\ntitle: A\n---\nbody\n' });
	const edit = folder.files.edit('notes/a.md');
	expect(folder.files.edit('notes/a.md')).toBe(edit);
	const typed = folder.files.edit('notes/a.md', notes);
	expect(folder.files.edit('notes/a.md', notes)).toBe(typed);
	expect(folder.tables.notes.edit('a')).toBe(typed);
	expect(typed).not.toBe(edit);
	const first = edit.getSnapshot();
	expect(edit.getSnapshot()).toBe(first);
	expect(Object.isFrozen(first)).toBe(true);
	expect(first).toEqual({
		content: undefined,
		loadError: undefined,
		isDirty: false,
		isSaving: false,
		saveError: undefined,
	});
	await flush();
	expect(log).toEqual([]);
	// Two views of one source: input through one shows in the other.
	expectOk(typed.replaceText('---\ntitle: Typed\n---\nbody\n'));
	expect(edit.getSnapshot().content?.text).toBe(
		'---\ntitle: Typed\n---\nbody\n',
	);
	const content = typed.getSnapshot().content!;
	expect(content.issues).toBeNull();
	if (content.issues === null) expect(content.fields.title).toBe('Typed');
	expect(Object.isFrozen(content)).toBe(true);
});

test('passive status follows overlapping writes and queued deletes without reading content', async () => {
	const { folder, hold, reads } = setup({ 'cold.txt': 'Do not read this' });
	const cold = folder.files.edit('cold.txt');
	const seen: (readonly string[])[] = [];
	const stop = folder.onStatusChange((status) => seen.push(status.savingPaths));
	cleanup.push(stop);
	const first = hold('write');
	const z = folder.files.write('z.txt', 'Z');
	await first.reached;
	const second = hold('write');
	const a = folder.files.write('a.txt', 'A');
	await second.reached;
	const deleting = hold('delete');
	const removed = folder.files.delete('z.txt');
	expect(folder.getStatus().savingPaths).toEqual(['a.txt', 'z.txt']);
	first.proceed();
	expectOk(await z);
	await deleting.reached;
	expect(folder.getStatus().savingPaths).toEqual(['a.txt', 'z.txt']);
	deleting.proceed();
	expectOk(await removed);
	expect(folder.getStatus().saving).toBe(true);
	expect(folder.getStatus().savingPaths).toEqual(['a.txt']);
	expect(seen.at(-1)).toEqual(['a.txt']);
	second.proceed();
	expectOk(await a);
	expect(folder.getStatus().savingPaths).toEqual([]);
	expect(folder.getStatus().saving).toBe(false);
	expect(reads()).toEqual([]);
	expect(cold.getSnapshot().content).toBeUndefined();
});

test('subscribing emits the current snapshot at once and starts the first read once', async () => {
	const { folder, reads } = setup({ 'a.md': 'alpha\n' });
	const edit = folder.files.edit('a.md');
	const first = record(edit);
	expect(first.seen).toEqual([edit.getSnapshot()]);
	expect(first.seen[0]!.content).toBeUndefined();
	await flush();
	expect(edit.getSnapshot().content?.text).toBe('alpha\n');
	expect(edit.getSnapshot().loadError).toBeUndefined();
	expect(first.seen.at(-1)).toBe(edit.getSnapshot());
	const second = record(edit);
	expect(second.seen).toEqual([edit.getSnapshot()]);
	await flush();
	expect(reads()).toEqual(['read a.md']);
	// The same text again changes nothing a subscriber sees.
	const count = first.seen.length;
	expectOk(edit.replaceText('alpha\n'));
	expect(first.seen).toHaveLength(count);
});

test('a path that was never there answers Missing with no content', async () => {
	const { folder } = setup();
	const edit = folder.files.edit('new.md');
	const refreshed = await edit.refresh();
	expect(expectErr(refreshed).name).toBe('Missing');
	expect(edit.getSnapshot()).toMatchObject({
		content: undefined,
		loadError: { name: 'Missing', path: 'new.md' },
	});
	expect(expectErr(await edit.save()).name).toBe('NoContent');
	expect(expectErr(edit.change({ body: 'x' })).name).toBe('NoContent');
});

test('input is accepted before the first read, and a read does not replace it', async () => {
	const { folder, hold, writes, text } = setup({ 'a.md': 'stored\n' });
	const edit = folder.files.edit('a.md');
	expectOk(edit.replaceText('typed first\n'));
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'typed first\n' },
		isDirty: true,
	});
	expectOk(await edit.refresh());
	expect(edit.getSnapshot().content?.text).toBe('typed first\n');
	expect(edit.getSnapshot().isDirty).toBe(true);
	const writing = hold('write');
	const saving = edit.save();
	await writing.reached;
	expect(edit.getSnapshot().isSaving).toBe(true);
	writing.proceed();
	expectOk(await saving);
	expect(text('a.md')).toBe('typed first\n');
	expect(writes()).toEqual(['write a.md typed first\n']);
	expect(edit.getSnapshot()).toMatchObject({ isDirty: false, isSaving: false });
});

test('only accepted input saves automatically; observations never write', async () => {
	const { folder, writes, outside, text } = setup({ 'a.md': 'one\n' }, 5);
	const edit = folder.files.edit('a.md');
	const { seen } = record(edit);
	await flush();
	outside('a.md', 'two\n');
	await sleep(20);
	expect(edit.getSnapshot().content?.text).toBe('two\n');
	expect(writes()).toEqual([]);
	expectOk(edit.replaceText('three\n'));
	await sleep(20);
	expect(text('a.md')).toBe('three\n');
	expect(writes()).toEqual(['write a.md three\n']);
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(seen.every((snapshot) => Object.isFrozen(snapshot))).toBe(true);
});

test('text is held after unsubscribing, deletion, binary replacement and failed reads', async () => {
	const { folder, outside, hold, disk, reads } = setup({ 'a.md': 'kept\n' });
	const edit = folder.files.edit('a.md');
	const { stop } = record(edit);
	await flush();
	stop();
	// Nobody watches: the change waits for the next subscription.
	outside('a.md', 'changed\n');
	await flush();
	expect(reads()).toHaveLength(1);
	expect(edit.getSnapshot().content?.text).toBe('kept\n');
	const again = record(edit);
	await flush();
	expect(edit.getSnapshot().content?.text).toBe('changed\n');
	again.stop();

	disk.set('a.md', Uint8Array.of(0xff, 0xfe, 0));
	expect(expectErr(await edit.refresh()).name).toBe('NotText');
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'changed\n' },
		loadError: { name: 'NotText' },
	});
	const reading = hold('read');
	const refreshing = edit.refresh();
	await reading.reached;
	reading.fail();
	expect(expectErr(await refreshing).name).toBe('ReadFailed');
	expect(edit.getSnapshot().loadError?.name).toBe('ReadFailed');
	disk.delete('a.md');
	expect(expectErr(await edit.refresh()).name).toBe('Missing');
	expect(edit.getSnapshot().content?.text).toBe('changed\n');
	// A local replacement does not clear the failure; a text read does.
	expectOk(edit.replaceText('local\n'));
	expect(edit.getSnapshot().loadError?.name).toBe('Missing');
	disk.set('a.md', encode('back\n'));
	expectOk(await edit.refresh());
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'local\n' },
		loadError: undefined,
		isDirty: true,
	});
});

test('typing during a publication stays dirty and visible when the publication lands', async () => {
	const { folder, hold, text } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('B\n'));
	const writing = hold('write');
	const saving = edit.save();
	await writing.reached;
	expectOk(edit.replaceText('C\n'));
	writing.proceed();
	expectOk(await saving);
	expect(text('a.md')).toBe('B\n');
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'C\n' },
		isDirty: true,
		isSaving: false,
	});
	expectOk(await edit.save());
	expect(text('a.md')).toBe('C\n');
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('identity, not text: new equal input survives an older publication and a delete that captured the old one', async () => {
	const { folder, hold, text, writes } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('B\n'));
	const writing = hold('write');
	const saving = edit.save();
	await writing.reached;
	const deleting = hold('delete');
	const removed = folder.files.delete('a.md');
	expectOk(edit.replaceText('C\n'));
	expectOk(edit.replaceText('B\n'));
	writing.proceed();
	expectOk(await saving);
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'B\n' },
		isDirty: true,
	});
	await deleting.reached;
	deleting.proceed();
	expectOk(await removed);
	expect(text('a.md')).toBeUndefined();
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'B\n' },
		isDirty: true,
	});
	// The newer input recreates the path.
	expectOk(await edit.save());
	expect(text('a.md')).toBe('B\n');
	expect(writes()).toEqual(['write a.md B\n', 'delete a.md', 'write a.md B\n']);
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('a delete defers an unsubmitted automatic save; failure resumes it, success consumes it', async () => {
	const { folder, hold, writes, text } = setup({ 'a.md': 'A\n' }, 10);
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('X\n'));
	const failing = hold('delete');
	const refused = folder.files.delete('a.md');
	await failing.reached;
	// New input can admit its own automatic save behind the delete.
	expectOk(edit.replaceText('Y\n'));
	await sleep(40);
	expect(writes()).toEqual([]);
	expect(edit.getSnapshot().isSaving).toBe(true);
	failing.fail();
	expect(expectErr(await refused).name).toBe('StorageFailed');
	await sleep(40);
	expect(writes()).toEqual(['write a.md Y\n']);
	expect(edit.getSnapshot().isDirty).toBe(false);

	expectOk(edit.replaceText('Z\n'));
	const deleting = hold('delete');
	const removed = folder.files.delete('a.md');
	await deleting.reached;
	await sleep(40);
	deleting.proceed();
	expectOk(await removed);
	await sleep(40);
	expect(writes()).toEqual(['write a.md Y\n', 'delete a.md']);
	expect(text('a.md')).toBeUndefined();
	// The delete's own outcome is known before it resolved.
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'Z\n' },
		isDirty: false,
		loadError: { name: 'Missing' },
	});
});

test('a failed delete never makes an already acknowledged intent dirty again', async () => {
	const { folder, hold, writes } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('B\n'));
	const writing = hold('write');
	const saving = edit.save();
	await writing.reached;
	const deleting = hold('delete');
	const removed = folder.files.delete('a.md');
	writing.proceed();
	expectOk(await saving);
	expect(edit.getSnapshot().isDirty).toBe(false);
	await deleting.reached;
	deleting.fail();
	expect(expectErr(await removed).name).toBe('StorageFailed');
	await flush();
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(writes()).toEqual(['write a.md B\n']);
});

test('save publishes the exact current text even when clean, and missing deletes succeed', async () => {
	const { folder, writes } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(await edit.save());
	expect(writes()).toEqual(['write a.md A\n']);
	expectOk(await folder.files.delete('a.md'));
	expectOk(await folder.files.delete('a.md'));
});

test('all writes and deletes of a path finish in call order; deletion is not saving', async () => {
	const { folder, hold, text } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	const order: string[] = [];
	const first = hold('write');
	const saving = edit.save().then((result) => {
		order.push('save');
		return result;
	});
	await first.reached;
	expect(edit.getSnapshot()).toMatchObject({ isDirty: false, isSaving: true });
	const direct = folder.files.write('a.md', 'direct\n').then((result) => {
		order.push('write');
		return result;
	});
	expectOk(edit.replaceText('B\n'));
	const again = edit.save().then((result) => {
		order.push('save again');
		return result;
	});
	expect(folder.getStatus().saving).toBe(true);
	first.proceed();
	expectOk(await saving);
	expectOk(await direct);
	expectOk(await again);
	expect(order).toEqual(['save', 'write', 'save again']);
	expect(text('a.md')).toBe('B\n');
	expect(edit.getSnapshot().isSaving).toBe(false);
	const deleting = hold('delete');
	const removed = folder.files.delete('a.md');
	await deleting.reached;
	expect(edit.getSnapshot().isSaving).toBe(false);
	expect(folder.getStatus().saving).toBe(true);
	deleting.proceed();
	expectOk(await removed);
	await flush();
	expect(folder.getStatus().saving).toBe(false);
});

test('a save failure survives typing until a success or discard, and cannot reattach after discard', async () => {
	const { folder, hold, writes } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('B\n'));
	const failing = hold('write');
	const saving = edit.save();
	await failing.reached;
	failing.fail();
	expect(expectErr(await saving).name).toBe('StorageFailed');
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		saveError: { name: 'StorageFailed' },
	});
	expect(folder.getStatus().failures).toEqual([
		{ path: 'a.md', text: 'B\n', error: edit.getSnapshot().saveError },
	]);
	expectOk(edit.replaceText('C\n'));
	expect(edit.getSnapshot().saveError?.name).toBe('StorageFailed');

	// Discard drops input and the failure, and writes nothing.
	expect(edit.discard()).toBe('C\n');
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'A\n' },
		isDirty: false,
		saveError: undefined,
	});
	expect(edit.discard()).toBeUndefined();

	// A publication admitted before a discard fails afterwards: its error stays away.
	expectOk(edit.replaceText('D\n'));
	const late = hold('write');
	const lateSave = edit.save();
	await late.reached;
	expect(edit.discard()).toBe('D\n');
	late.fail();
	expect(expectErr(await lateSave).name).toBe('StorageFailed');
	expect(edit.getSnapshot().saveError).toBeUndefined();

	// A later success clears a failure.
	expectOk(edit.replaceText('E\n'));
	const again = hold('write');
	const failed = edit.save();
	await again.reached;
	again.fail();
	await failed;
	expect(edit.getSnapshot().saveError?.name).toBe('StorageFailed');
	expectOk(await edit.save());
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: false,
		saveError: undefined,
	});
	expect(writes()).toEqual(['write a.md E\n']);
});

test('a read waits for admitted writes, so an acknowledgement never lands over a newer observation', async () => {
	const { folder, hold, disk, log } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('B\n'));
	const writing = hold('write');
	const saving = edit.save();
	await writing.reached;
	disk.set('a.md', encode('outside\n'));
	const refreshing = edit.refresh();
	await flush();
	expect(log).toEqual(['read a.md']);
	writing.proceed();
	expectOk(await saving);
	expectOk(await refreshing);
	expect(log).toEqual(['read a.md', 'write a.md B\n', 'read a.md']);
	expect(edit.getSnapshot().content?.text).toBe('B\n');
	// Someone else writes after the acknowledgement: the next read shows it.
	disk.set('a.md', encode('theirs\n'));
	expectOk(await edit.refresh());
	expect(edit.getSnapshot().content?.text).toBe('theirs\n');
});

test('a change reported while a read runs is read again afterwards', async () => {
	const { folder, hold, outside, reads } = setup({ 'a.md': 'old\n' });
	const edit = folder.files.edit('a.md');
	const { seen } = record(edit);
	const reading = hold('read');
	const refreshing = edit.refresh();
	await reading.reached;
	outside('a.md', 'new\n');
	reading.proceed();
	expectOk(await refreshing);
	expect(edit.getSnapshot().content?.text).toBe('new\n');
	expect(reads().length).toBeGreaterThanOrEqual(2);
	expect(
		seen.some((snapshot: EditorSnapshot) => snapshot.content?.text === 'old\n'),
	).toBe(false);
});

test('change patches fields and body of the current text, owns nested values, and refuses what it cannot apply', async () => {
	const { folder } = setup({ 'notes/a.md': '---\ntitle: A\n---\nbody\n' });
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	const tags = ['x'];
	expectOk(
		edit.change({
			fields: { title: 'B', tags } as unknown as { title: string },
			body: 'new body\n',
		}),
	);
	tags.push('y');
	expect(edit.getSnapshot().content?.text).toBe(
		'---\ntitle: B\ntags:\n  - x\n---\nnew body\n',
	);
	expect(edit.getSnapshot().content?.fields).toMatchObject({ title: 'B' });
	expectOk(edit.replaceText('---\ntitle: [broken\n---\nbody\n'));
	expect(expectErr(edit.change({ fields: { title: 'C' } })).name).toBe(
		'InvalidFields',
	);
	expectOk(edit.change({ body: 'repaired body\n' }));
	expect(edit.getSnapshot().content?.text).toBe(
		'---\ntitle: [broken\n---\nrepaired body\n',
	);
	expect(expectErr(edit.replaceText('a\0b')).name).toBe('InvalidText');
	expect(expectErr(edit.replaceText('a\uD800b')).name).toBe('InvalidText');
});

test('close refuses input, submits held input once, answers recoveries and keeps editors readable', async () => {
	const { folder, hold } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('B\n'));
	const writing = hold('write');
	const closing = folder.close();
	expect(folder.close()).toBe(closing);
	expect(expectErr(edit.replaceText('C\n')).name).toBe('Closing');
	await writing.reached;
	writing.fail();
	const recoveries = await closing;
	expect(recoveries).toEqual([
		{ path: 'a.md', text: 'B\n', error: edit.getSnapshot().saveError },
	]);
	expect(recoveries[0]!.error?.name).toBe('StorageFailed');
	expect(edit.getSnapshot().content?.text).toBe('B\n');
	expect(expectErr(await edit.save()).name).toBe('Closed');
	expect(() => folder.files.list()).toThrow('The folder is closed');
	expect(expectErr(await folder.run(async () => 1)).name).toBe('Closing');
});

test('an action admitted before close finishes its writes while close drains', async () => {
	const { folder, text } = setup();
	const gate = Promise.withResolvers<void>();
	const action = folder.run(async () => {
		await gate.promise;
		return folder.files.write('receipt.md', 'sent\n');
	});
	const closing = folder.close();
	gate.resolve();
	const ran = expectOk(await action);
	expectOk(ran as Result<void, SaveError>);
	expect(await closing).toEqual([]);
	expect(text('receipt.md')).toBe('sent\n');
});

test('settle submits held input, failed input included, and answers what did not save', async () => {
	const { folder, hold, text } = setup({ 'a.md': 'A\n', 'b.md': 'B\n' });
	const a = folder.files.edit('a.md');
	const b = folder.files.edit('b.md');
	expectOk(a.replaceText('A2\n'));
	expectOk(b.replaceText('B2\n'));
	const failing = hold('write');
	const settling = folder.settle();
	await failing.reached;
	failing.fail();
	const settled = await settling;
	expect(settled.map((recovery) => recovery.path)).toEqual(['a.md']);
	expect(settled[0]!.error?.name).toBe('StorageFailed');
	expect(text('b.md')).toBe('B2\n');
	expect(folder.getStatus().unsaved).toEqual(['a.md']);
	expect(await folder.settle()).toEqual([]);
	expect(text('a.md')).toBe('A2\n');
});

test('over the browser engine an editor saves automatically and learns of another handle through a listing', async () => {
	globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
	const folder = expectOk(
		await openFolder({ tables: { notes }, saveAfterMs: 5 }),
	);
	cleanup.push(() => folder.close());
	const other = expectOk(await openFolder({ tables: { notes } }));
	cleanup.push(() => other.close());
	expectOk(await other.tables.notes.set('a', { fields: { title: 'A' } }));
	const edit = folder.tables.notes.edit('a');
	const { seen } = record(edit);
	for (
		let turn = 0;
		turn < 50 && edit.getSnapshot().content === undefined;
		turn++
	)
		await sleep(5);
	expect(edit.getSnapshot().content?.fields).toEqual({ title: 'A' });
	expectOk(edit.change({ fields: { title: 'Mine' } }));
	for (let turn = 0; turn < 50 && edit.getSnapshot().isDirty; turn++)
		await sleep(5);
	expect(expectOk(await other.tables.notes.get('a'))?.fields).toEqual({
		title: 'Mine',
	});
	expectOk(await other.tables.notes.set('a', { fields: { title: 'Theirs' } }));
	expectOk(await folder.tables.notes.list());
	for (
		let turn = 0;
		turn < 50 && edit.getSnapshot().content?.fields?.title !== 'Theirs';
		turn++
	)
		await sleep(5);
	expect(edit.getSnapshot().content?.fields).toEqual({ title: 'Theirs' });
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(seen.length).toBeGreaterThan(1);
});

const row = (title: string, body: string) =>
	`---\ntitle: ${title}\n---\n${body}`;

test('a row list installs each exact text before it resolves, with no further read', async () => {
	const { folder, reads, log } = setup({
		'notes/a.md': row('A', 'one\n'),
		'notes/b.md': row('B', 'two\n'),
	});
	const listed = expectOk(await folder.tables.notes.list());
	expect(listed.map((found) => found.id)).toEqual(['a', 'b']);
	const edit = folder.tables.notes.edit('a');
	// Acquired after the list, the editor already knows the row.
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: row('A', 'one\n') },
		loadError: undefined,
	});
	expectOk(edit.change({ fields: { title: 'Changed' } }));
	// Subscribing to a listed row reads nothing again, and no listed row read in the background.
	const { stop } = record(edit);
	await flush();
	stop();
	expect(reads()).toEqual([]);
	expect(log).toEqual(['list notes']);
	// A list answers stored rows; the editor keeps its input.
	const again = expectOk(await folder.tables.notes.list());
	expect(again[0]!.fields).toEqual({ title: 'A' });
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { fields: { title: 'Changed' } },
	});
});

test('a row get acquires its text or Missing, and its failure becomes the known load error', async () => {
	const { folder, hold } = setup({ 'notes/a.md': row('A', 'one\n') });
	expectOk(await folder.tables.notes.get('a'));
	expectOk(folder.tables.notes.edit('a').change({ body: 'typed\n' }));
	expect(expectOk(await folder.tables.notes.get('gone'))).toBeUndefined();
	expect(folder.tables.notes.edit('gone').getSnapshot().loadError?.name).toBe(
		'Missing',
	);
	const failing = hold('get');
	const getting = folder.tables.notes.get('a');
	await failing.reached;
	failing.fail();
	expect(expectErr(await getting).name).toBe('StorageFailed');
	expect(folder.tables.notes.edit('a').getSnapshot()).toMatchObject({
		loadError: { name: 'ReadFailed' },
		isDirty: true,
		content: { body: 'typed\n' },
	});
});

test('a list that started before a publication never installs over it', async () => {
	const { folder, hold, text } = setup({ 'notes/a.md': row('A', 'old\n') });
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	const listing = hold('list');
	const listed = folder.tables.notes.list();
	await listing.reached;
	expectOk(edit.replaceText(row('A', 'new\n')));
	expectOk(await edit.save());
	expect(text('notes/a.md')).toBe(row('A', 'new\n'));
	listing.proceed();
	// The list answers what it found; the editor keeps the newer publication.
	expect(expectOk(await listed)[0]!.body).toBe('old\n');
	expect(edit.getSnapshot().content?.text).toBe(row('A', 'new\n'));
	// A list that started before another handle's reported change stays out too.
	const second = hold('list');
	const listing2 = folder.tables.notes.list();
	await second.reached;
	const other = folder.tables.notes.edit('b');
	expect(other.getSnapshot().content).toBeUndefined();
	second.proceed();
	await listing2;
	expect(edit.getSnapshot().content?.text).toBe(row('A', 'new\n'));
});

test('a direct set composes over held input, publishes it, and acknowledges only that input', async () => {
	const { folder, text, writes } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText(row('Old', 'Typed\n')));
	const stored = expectOk(
		await folder.tables.notes.set('a', { fields: { title: 'New' } }),
	);
	expect(stored.text).toBe(row('New', 'Typed\n'));
	expect(text('notes/a.md')).toBe(row('New', 'Typed\n'));
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: false,
		content: { text: row('New', 'Typed\n') },
	});
	// Nothing is left to send: settle and close write nothing more.
	expect(await folder.settle()).toEqual([]);
	expect(await folder.close()).toEqual([]);
	expect(writes()).toEqual([`write notes/a.md ${row('New', 'Typed\n')}`]);
});

test('a failed direct set changes nothing held and is never retried', async () => {
	const { folder, hold, writes } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText(row('Old', 'Typed\n')));
	const before = edit.getSnapshot();
	const failing = hold('write');
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	await failing.reached;
	failing.fail();
	expect(expectErr(await setting).name).toBe('StorageFailed');
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		saveError: undefined,
		content: { text: before.content!.text },
	});
	// Its interrupted autosave resumes with the original input, never the failed command.
	expect(await folder.close()).toEqual([]);
	expect(writes()).toEqual([`write notes/a.md ${row('Old', 'Typed\n')}`]);
});

test('input typed while a direct set waits stays, and may later replace the whole file', async () => {
	const { folder, hold, text } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText(row('Old', 'B\n')));
	const writing = hold('write');
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	await writing.reached;
	// Not shown before it lands: no optimistic text.
	expect(edit.getSnapshot().content?.text).toBe(row('Old', 'B\n'));
	expectOk(edit.replaceText(row('Old', 'C\n')));
	// The same text again is new input with its own identity.
	expectOk(edit.replaceText(row('Old', 'B\n')));
	writing.proceed();
	expectOk(await setting);
	expect(text('notes/a.md')).toBe(row('New', 'B\n'));
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { text: row('Old', 'B\n') },
	});
	expectOk(await edit.save());
	expect(text('notes/a.md')).toBe(row('Old', 'B\n'));
});

test('a direct set with no held text reads in the lane after earlier commands', async () => {
	const { folder, hold, log, text } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const writing = hold('write');
	const written = folder.files.write('notes/a.md', row('Raw', 'Written\n'));
	await writing.reached;
	const setting = folder.tables.notes.set('a', { fields: { title: 'Set' } });
	writing.proceed();
	expectOk(await written);
	expect(expectOk(await setting).text).toBe(row('Set', 'Written\n'));
	expect(text('notes/a.md')).toBe(row('Set', 'Written\n'));
	expect(log.indexOf('read notes/a.md')).toBeGreaterThan(
		log.indexOf(`write notes/a.md ${row('Raw', 'Written\n')}`),
	);
	// A new row needs a portable id; an existing one is composed as found.
	expect(
		expectErr(await folder.tables.notes.set('a?', { body: 'x' })).name,
	).toBe('InvalidId');
});

test('a raw write acknowledges only the input captured at its call and is known before it resolves', async () => {
	const { folder, hold } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('typed\n'));
	expectOk(await folder.files.write('a.md', 'raw\n'));
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: false,
		content: { text: 'raw\n' },
	});
	expectOk(edit.replaceText('B\n'));
	const writing = hold('write');
	const written = folder.files.write('a.md', 'raw again\n');
	await writing.reached;
	expectOk(edit.replaceText('C\n'));
	writing.proceed();
	expectOk(await written);
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { text: 'C\n' },
	});
	// A failed raw write changes nothing held.
	const failing = hold('write');
	const refused = folder.files.write('a.md', 'never\n');
	await failing.reached;
	failing.fail();
	expect(expectErr(await refused).name).toBe('StorageFailed');
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		saveError: undefined,
		content: { text: 'C\n' },
	});
});

test('a raw read never decodes a passive editor’s file, and keeps an engaged one current', async () => {
	const large = new Uint8Array(2 * 1024 * 1024).fill(0xff);
	const { folder, decoded, disk, reads } = setup({
		'large.wav': large,
		'a.md': 'A\n',
	});
	const wav = folder.files.edit('large.wav');
	const read = expectOk(await folder.files.read('large.wav'));
	expect(read?.content.size).toBe(large.length);
	expect(decoded.count).toBe(0);
	expect(wav.getSnapshot()).toMatchObject({
		content: undefined,
		loadError: undefined,
	});
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	disk.set('a.md', encode('changed\n'));
	const before = reads().length;
	expectOk(await folder.files.read('a.md'));
	expect(edit.getSnapshot().content?.text).toBe('changed\n');
	// The raw read itself answered; the editor did not read again.
	expect(reads().length).toBe(before + 1);
});

test('a read overtaken again and again reads until one applies, never installing an older answer', async () => {
	const { folder, hold, outside, reads } = setup({ 'a.md': '0' });
	const edit = folder.files.edit('a.md');
	const first = hold('read');
	const { stop } = record(edit);
	cleanup.push(stop);
	await first.reached;
	let held = first;
	for (let change = 1; change <= 8; change++) {
		const next = hold('read');
		outside('a.md', String(change));
		held.proceed();
		await next.reached;
		held = next;
		// Every answer so far was overtaken: nothing older is installed.
		expect(edit.getSnapshot().content).toBeUndefined();
	}
	held.proceed();
	await flush();
	expect(edit.getSnapshot().content?.text).toBe('8');
	expect(reads()).toHaveLength(9);
	await flush();
	expect(reads()).toHaveLength(9);
});

test('snapshot content is frozen all the way down', async () => {
	const { folder } = setup({
		'notes/a.md': '---\ntitle: A\ntags:\n  - x\n---\nbody\n',
	});
	const edit = folder.files.edit('notes/a.md');
	expectOk(await edit.refresh());
	const content = edit.getSnapshot().content!;
	const tags = (content.fields as { tags: string[] }).tags;
	expect(() => tags.push('y')).toThrow();
	expect(edit.getSnapshot().content?.fields).toEqual({
		title: 'A',
		tags: ['x'],
	});
	expectOk(edit.replaceText('---\ntitle: [x\n---\nbody\n'));
	const issues = edit.getSnapshot().content!.issues!;
	expect(Object.isFrozen(issues)).toBe(true);
	expect(Object.isFrozen(issues[0]!.path)).toBe(true);
	const missing = folder.files.edit('gone.md');
	await missing.refresh();
	expect(Object.isFrozen(missing.getSnapshot().loadError)).toBe(true);
});

test('a discard supersedes the failure of a clean save admitted before it', async () => {
	const { folder, hold } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	const failing = hold('write');
	const saving = edit.save();
	await failing.reached;
	expect(edit.discard()).toBeUndefined();
	failing.fail();
	expect(expectErr(await saving).name).toBe('StorageFailed');
	expect(edit.getSnapshot().saveError).toBeUndefined();
});

test('reported directory changes reach subscribed editors below them; passive ones are only marked', async () => {
	const { folder, emit, reads, disk } = setup({
		'notes/a.md': 'a\n',
		'notes/deep/b.md': 'b\n',
		'other.md': 'o\n',
	});
	const a = folder.files.edit('notes/a.md');
	const b = folder.files.edit('notes/deep/b.md');
	const other = folder.files.edit('other.md');
	cleanup.push(record(a).stop, record(b).stop, record(other).stop);
	const passive = folder.files.edit('notes/passive.md');
	await flush();
	const count = () => reads().length;
	expect(count()).toBe(3);
	for (const [hint, expected] of [
		['notes', 5],
		['notes/', 7],
		['notes/deep', 8],
		['', 11],
	] as const) {
		disk.set('notes/a.md', encode(hint));
		emit({ paths: [hint], origin: 'other-handle' });
		await flush();
		expect(count()).toBe(expected);
	}
	expect(a.getSnapshot().content?.text).toBe('');
	emit({ paths: null, origin: 'other-handle' });
	await flush();
	expect(count()).toBe(14);
	expect(reads()).not.toContain('read notes/passive.md');
	expect(passive.getSnapshot().content).toBeUndefined();
});

test('folder.refresh reads current subscribers in scope, marks the rest, and lists start no reads', async () => {
	const { folder, reads, disk } = setup({
		'notes/a.md': row('A', 'a\n'),
		'notes/b.md': row('B', 'b\n'),
		'other.md': 'o\n',
	});
	expectOk(await folder.tables.notes.list());
	const watched = folder.tables.notes.edit('a');
	const resting = folder.tables.notes.edit('b');
	const other = folder.files.edit('other.md');
	cleanup.push(record(watched).stop, record(other).stop);
	await flush();
	// Listed rows are known: only the unlisted file read for its subscriber.
	expect(reads()).toEqual(['read other.md']);
	await folder.refresh([]);
	expect(reads()).toHaveLength(1);
	disk.set('notes/a.md', encode(row('A2', 'a\n')));
	disk.set('notes/b.md', encode(row('B2', 'b\n')));
	await folder.refresh(['notes/']);
	expect(reads()).toEqual(['read other.md', 'read notes/a.md']);
	expect(watched.getSnapshot().content?.fields).toEqual({ title: 'A2' });
	expect(resting.getSnapshot().content?.fields).toEqual({ title: 'B' });
	// The resting editor reads once it is subscribed again.
	cleanup.push(record(resting).stop);
	await flush();
	expect(resting.getSnapshot().content?.fields).toEqual({ title: 'B2' });
	await folder.refresh();
	expect(reads().filter((entry) => entry === 'read other.md')).toHaveLength(2);
});

test('a typed list overtaken by a reported change still leaves usable text for a row nobody held', async () => {
	const { folder, hold, emit, disk, reads } = setup({
		'notes/a.md': row('A', 'one\n'),
	});
	const listing = hold('list');
	const listed = folder.tables.notes.list();
	await listing.reached;
	disk.set('notes/a.md', encode(row('Peer', 'one\n')));
	emit({ paths: ['notes/a.md'], origin: 'other-handle' });
	listing.proceed();
	expect(expectOk(await listed)[0]!.fields).toEqual({ title: 'A' });
	// Usable at once, with no further wait; nobody subscribed, so nothing reads.
	const edit = folder.tables.notes.edit('a');
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: row('A', 'one\n') },
		loadError: undefined,
	});
	expect(reads()).toEqual([]);
	// It is not current: the first subscriber reads what overtook it.
	cleanup.push(record(edit).stop);
	await flush();
	expect(reads()).toEqual(['read notes/a.md']);
	expect(edit.getSnapshot().content?.fields).toEqual({ title: 'Peer' });
	// The same through a directory hint.
	const second = hold('list');
	const again = folder.tables.notes.list();
	await second.reached;
	disk.set('notes/b.md', encode(row('B', 'two\n')));
	emit({ paths: ['notes/'], origin: 'other-handle' });
	second.proceed();
	await again;
	expectOk(folder.tables.notes.edit('a').change({ body: 'typed\n' }));
});

test('a cold row get while a raw write is admitted is usable at once, and the write lands over it', async () => {
	const { folder, hold, reads } = setup({ 'notes/a.md': row('A', 'old\n') });
	const writing = hold('write');
	const written = folder.files.write('notes/a.md', row('W', 'new\n'));
	await writing.reached;
	expectOk(await folder.tables.notes.get('a'));
	const edit = folder.tables.notes.edit('a');
	expect(edit.getSnapshot().content?.text).toBe(row('A', 'old\n'));
	writing.proceed();
	expectOk(await written);
	// The source acquired while the write ran learned it before it resolved.
	expect(edit.getSnapshot().content?.text).toBe(row('W', 'new\n'));
	expect(reads()).toEqual([]);
});

test('an overtaken typed result advances held text without claiming freshness', async () => {
	const { folder, hold, disk, emit, reads } = setup({
		'notes/a.md': row('A', 'original\n'),
	});
	expectOk(await folder.tables.notes.get('a'));
	const edit = folder.tables.notes.edit('a');
	disk.set('notes/a.md', encode(row('B', 'listed\n')));
	const listing = hold('list');
	const listed = folder.tables.notes.list();
	await listing.reached;
	disk.set('notes/a.md', encode(row('C', 'latest\n')));
	emit({ paths: ['notes/a.md'], origin: 'other-handle' });
	listing.proceed();
	await listed;
	expect(edit.getSnapshot().content?.text).toBe(row('B', 'listed\n'));
	expect(reads()).toEqual([]);
	cleanup.push(record(edit).stop);
	await flush();
	expect(edit.getSnapshot().content?.text).toBe(row('C', 'latest\n'));
	expect(reads()).toEqual(['read notes/a.md']);
});

for (const outcome of ['Missing', 'NotText', 'ReadFailed'] as const) {
	test(`a newer ${outcome} observation retains the newest usable typed text`, async () => {
		const { folder, hold, disk } = setup({
			'notes/a.md': row('A', 'original\n'),
		});
		expectOk(await folder.tables.notes.get('a'));
		const edit = folder.tables.notes.edit('a');
		disk.set('notes/a.md', encode(row('B', 'newer usable\n')));
		const reading = hold('get');
		const found = folder.tables.notes.get('a');
		await reading.reached;
		if (outcome === 'ReadFailed') {
			const failure = hold('read');
			const refreshed = edit.refresh();
			await failure.reached;
			failure.fail();
			expectErr(await refreshed);
		} else {
			expectOk(
				await (outcome === 'Missing'
					? folder.files.delete('notes/a.md')
					: folder.files.write('notes/a.md', new Uint8Array([0]))),
			);
		}
		reading.proceed();
		expectOk(await found);
		expect(edit.getSnapshot()).toMatchObject({
			content: { text: row('B', 'newer usable\n') },
			loadError: { name: outcome },
			isDirty: false,
		});
	});
}

test('a list that started before a publication to a row nobody held installs the publication', async () => {
	const { folder, hold, reads } = setup({ 'notes/a.md': row('A', 'old\n') });
	const listing = hold('list');
	const listed = folder.tables.notes.list();
	await listing.reached;
	expectOk(await folder.files.write('notes/a.md', row('W', 'new\n')));
	listing.proceed();
	expect(expectOk(await listed)[0]!.body).toBe('old\n');
	expect(folder.tables.notes.edit('a').getSnapshot().content?.text).toBe(
		row('W', 'new\n'),
	);
	expect(reads()).toEqual([]);
});

test('an editor acquired while a raw write runs learns it before the write resolves', async () => {
	const { folder, hold, reads } = setup({ 'a.md': 'old\n' });
	const writing = hold('write');
	const written = folder.files.write('a.md', 'new\n');
	await writing.reached;
	const edit = folder.files.edit('a.md');
	writing.proceed();
	expectOk(await written);
	expect(edit.getSnapshot().content?.text).toBe('new\n');
	expect(reads()).toEqual([]);
});

for (const publication of ['binary', 'delete'] as const) {
	test(`a cold typed read retains usable text after a newer ${publication} publication`, async () => {
		const original = row('A', 'old\n');
		const { folder, hold, reads, writes } = setup({ 'notes/a.md': original });
		const listing = hold('list');
		const listed = folder.tables.notes.list();
		await listing.reached;
		expectOk(
			await (publication === 'binary'
				? folder.files.write('notes/a.md', new Uint8Array([0]))
				: folder.files.delete('notes/a.md')),
		);
		listing.proceed();
		expect(expectOk(await listed)[0]!.text).toBe(original);
		const edit = folder.tables.notes.edit('a');
		expect(edit.getSnapshot()).toMatchObject({
			content: { text: original },
			loadError: { name: publication === 'binary' ? 'NotText' : 'Missing' },
			isDirty: false,
		});
		expect(reads()).toEqual([]);
		const publications = writes().length;
		cleanup.push(record(edit).stop);
		await flush();
		expect(edit.getSnapshot().content?.text).toBe(original);
		expect(writes()).toHaveLength(publications);
	});
}

test('late usable text fills an empty source without clearing a newer Missing', async () => {
	const { folder, hold, emit, disk } = setup({
		'notes/a.md': row('A', 'one\n'),
	});
	const edit = folder.tables.notes.edit('a');
	const listing = hold('list');
	const listed = folder.tables.notes.list();
	await listing.reached;
	disk.delete('notes/a.md');
	emit({ paths: ['notes/a.md'], origin: 'other-handle' });
	expect(expectErr(await edit.refresh()).name).toBe('Missing');
	listing.proceed();
	await listed;
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: row('A', 'one\n') },
		loadError: { name: 'Missing' },
	});
});

const draftRow = (draft: boolean, body: string) =>
	draft
		? `---\ntitle: T\ndraft: true\n---\n${body}`
		: `---\ntitle: T\n---\n${body}`;

test('close during a direct promotion never queues the input that promotion captured', async () => {
	const { folder, hold, text, writes } = setup();
	expectOk(
		await folder.tables.notes.set('a', {
			fields: { title: 'T', draft: true } as never,
			body: 'raw\n',
		}),
	);
	const edit = folder.tables.notes.edit('a');
	expectOk(edit.change({ body: 'raw input\n' }));
	const writing = hold('write');
	const promotion = folder.tables.notes.set('a', {
		fields: { draft: undefined } as never,
		body: 'composed\n',
	});
	const closing = folder.close();
	await writing.reached;
	writing.proceed();
	expectOk(await promotion);
	expect(await closing).toEqual([]);
	expect(text('notes/a.md')).toBe(draftRow(false, 'composed\n'));
	// The first set and the promotion; the raw input never follows it.
	expect(writes()).toHaveLength(2);
	expect(writes()[1]).toBe(`write notes/a.md ${draftRow(false, 'composed\n')}`);
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('an automatic save coming due during a direct set never publishes its captured input after it', async () => {
	const { folder, hold, text, writes } = setup(
		{ 'notes/a.md': row('Old', 'Original\n') },
		10,
	);
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText(row('Old', 'Typed\n')));
	const writing = hold('write');
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	await writing.reached;
	await sleep(40);
	writing.proceed();
	expectOk(await setting);
	await sleep(40);
	expect(text('notes/a.md')).toBe(row('New', 'Typed\n'));
	expect(writes()).toEqual([`write notes/a.md ${row('New', 'Typed\n')}`]);
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('an older command failing gives captured input back only if no later command owns it', async () => {
	const { folder, hold, writes } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText(row('Old', 'I\n')));
	const first = hold('write');
	const second = hold('write');
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	const saving = edit.save();
	await first.reached;
	first.fail();
	expect(expectErr(await setting).name).toBe('StorageFailed');
	// The later save still owns the input: settle submits nothing behind it.
	const settling = folder.settle();
	await second.reached;
	second.proceed();
	expectOk(await saving);
	expect(await settling).toEqual([]);
	expect(writes()).toEqual([`write notes/a.md ${row('Old', 'I\n')}`]);
	// The last owner failing does give it back, for a later explicit save or close.
	expectOk(edit.replaceText(row('Old', 'J\n')));
	const failing = hold('write');
	const failed = folder.tables.notes.set('a', { fields: { title: 'Newer' } });
	await failing.reached;
	failing.fail();
	await failed;
	expect(await folder.close()).toEqual([]);
	expect(writes().at(-1)).toBe(`write notes/a.md ${row('Old', 'J\n')}`);
});

test('close during a raw write never queues the input it captured', async () => {
	const { folder, hold, text, writes } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('typed\n'));
	const writing = hold('write');
	const written = folder.files.write('a.md', 'raw\n');
	const closing = folder.close();
	await writing.reached;
	writing.proceed();
	expectOk(await written);
	expect(await closing).toEqual([]);
	expect(text('a.md')).toBe('raw\n');
	expect(writes()).toEqual(['write a.md raw\n']);
});

test('a failed direct set during close resumes the original input publication', async () => {
	const { folder, hold, text } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText(row('Old', 'I\n')));
	const failing = hold('write');
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	const closing = folder.close();
	await failing.reached;
	failing.fail();
	expect(expectErr(await setting).name).toBe('StorageFailed');
	expect(await closing).toEqual([]);
	expect(text('notes/a.md')).toBe(row('Old', 'I\n'));
});

test('overlapping failed commands resume interrupted input once, never their payloads', async () => {
	const { folder, hold, writes, text } = setup({
		'notes/a.md': row('Old', 'original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText(row('Old', 'input\n')));
	const first = hold('write');
	const second = hold('write');
	const resumed = hold('write');
	const raw = folder.files.write('notes/a.md', row('Raw', 'command\n'));
	const set = folder.tables.notes.set('a', { fields: { title: 'Set' } });
	await first.reached;
	first.fail();
	expectErr(await raw);
	await second.reached;
	second.fail();
	expectErr(await set);
	await resumed.reached;
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		isSaving: true,
		saveError: undefined,
	});
	resumed.proceed();
	await flush();
	expect(text('notes/a.md')).toBe(row('Old', 'input\n'));
	expect(writes()).toEqual([`write notes/a.md ${row('Old', 'input\n')}`]);
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('a failed command does not autonomously retry input whose own save already failed', async () => {
	const { folder, hold, writes } = setup({ 'a.md': 'original\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('input\n'));
	const input = hold('write');
	const saving = edit.save();
	await input.reached;
	input.fail();
	expectErr(await saving);
	const command = hold('write');
	const writing = folder.files.write('a.md', 'command\n');
	await command.reached;
	command.fail();
	expectErr(await writing);
	await flush();
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		isSaving: false,
		saveError: { name: 'StorageFailed' },
	});
	expect(writes()).toEqual([]);
});

test('new equal input typed during a direct set is still published after it', async () => {
	const { folder, hold, text } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText(row('Old', 'B\n')));
	const writing = hold('write');
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	await writing.reached;
	expectOk(edit.replaceText(row('Old', 'C\n')));
	expectOk(edit.replaceText(row('Old', 'B\n')));
	const closing = folder.close();
	writing.proceed();
	expectOk(await setting);
	expect(await closing).toEqual([]);
	expect(text('notes/a.md')).toBe(row('Old', 'B\n'));
});

test('over the browser engine a direct set composes over held input, and a failure keeps it', async () => {
	globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
	const folder = expectOk(
		await openFolder({ tables: { notes }, saveAfterMs: 60_000 }),
	);
	cleanup.push(() => folder.close());
	expectOk(await folder.files.write('notes/a.md', row('Old', 'Original\n')));
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText(row('Old', 'Typed\n')));
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	try {
		expect(
			expectErr(
				await folder.tables.notes.set('a', { fields: { title: 'New' } }),
			).name,
		).toBe('StorageFailed');
	} finally {
		IDBObjectStore.prototype.put = put;
	}
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		saveError: undefined,
		content: { text: row('Old', 'Typed\n') },
	});
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	expectOk(edit.replaceText(row('Old', 'Later\n')));
	expectOk(await setting);
	expect(expectOk(await folder.tables.notes.get('a'))?.text).toBe(
		row('New', 'Typed\n'),
	);
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { text: row('Old', 'Later\n') },
	});
});
