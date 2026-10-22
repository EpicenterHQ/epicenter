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
 * - Close releases synchronously without submitting input or waiting for writes
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { Type } from 'typebox';
import { Ok } from 'wellcrafted/result';
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
	const writeFailure = SaveError.StorageFailed({
		cause: new Error('disk full'),
	});
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
				if (!(await gate('write'))) return writeFailure;
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
		writeError: writeFailure.error,
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

test('passive status retains snapshot identity until save metadata changes', async () => {
	const { folder } = setup();
	const initial = folder.getStatus();
	const seen: (typeof initial)[] = [];
	cleanup.push(folder.onStatusChange((status) => seen.push(status)));
	const edit = folder.files.edit('a.md');
	expect(folder.getStatus()).toBe(initial);
	expectOk(edit.replaceText('first'));
	const dirty = folder.getStatus();
	expect(dirty.unsaved).toEqual(['a.md']);
	expect(seen).toEqual([dirty]);
	// Text changes while the same input remains outstanding need no metadata event.
	expectOk(edit.replaceText('second'));
	expect(folder.getStatus()).toBe(dirty);
	expect(seen).toEqual([dirty]);
	const saving = edit.save();
	expect(folder.getStatus().savingPaths).toEqual(['a.md']);
	expectOk(await saving);
	expect(folder.getStatus().unsaved).toEqual([]);
	expect(initial.unsaved).toEqual([]);
	expect(dirty.unsaved).toEqual(['a.md']);
});

test('status remembers storage write and delete failures without replacing them with read failures', async () => {
	const { folder, hold } = setup({ 'a.md': 'before' });
	const failingWrite = hold('write');
	const writing = folder.files.write('a.md', 'after');
	await failingWrite.reached;
	failingWrite.fail();
	const writeError = expectErr(await writing);
	if (writeError.name !== 'StorageFailed')
		throw new Error('Expected a storage write failure');
	expect(folder.getStatus().storageFailure).toBe(writeError);
	const failingRead = hold('read');
	const refreshing = folder.files.edit('unknown').refresh();
	await failingRead.reached;
	failingRead.fail();
	expect(expectErr(await refreshing).name).toBe('ReadFailed');
	expect(folder.getStatus().storageFailure).toBe(writeError);
	const failingDelete = hold('delete');
	const deleting = folder.files.delete('a.md');
	await failingDelete.reached;
	failingDelete.fail();
	const deleteError = expectErr(await deleting);
	if (deleteError.name !== 'StorageFailed')
		throw new Error('Expected a storage delete failure');
	expect(folder.getStatus().storageFailure).toBe(deleteError);
	expectOk(await folder.files.delete('a.md'));
	expect(folder.getStatus().storageFailure).toBeNull();
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

test('a failed publication has stable identity through typing and a fresh identity after retry', async () => {
	const { folder, hold, writeError } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	const typed = '\uFEFFB\r\n';
	expectOk(edit.replaceText(typed));
	const failing = hold('write');
	const saving = edit.save();
	await failing.reached;
	failing.fail();
	expect(expectErr(await saving).name).toBe('StorageFailed');
	const failedStatus = folder.getStatus();
	const [first] = failedStatus.failures;
	if (first === undefined) throw new Error('Expected a failed publication');
	expect(first.error).toBe(writeError);
	expect(Object.isFrozen(first)).toBe(true);
	expect('text' in first).toBe(false);
	expect(edit.getSnapshot().content?.text).toBe(typed);

	const statuses: (typeof failedStatus)[] = [];
	cleanup.push(folder.onStatusChange((status) => statuses.push(status)));
	expectOk(edit.replaceText('\uFEFFC\r\n'));
	expect(folder.getStatus()).toBe(failedStatus);
	expect(folder.getStatus().failures[0]).toBe(first);
	expect(statuses).toEqual([]);

	const retrying = hold('write');
	const retry = edit.save();
	await retrying.reached;
	expect(folder.getStatus().failures).toEqual([]);
	expectOk(edit.replaceText('\uFEFFD\r\n'));
	expect(folder.getStatus().failures[0]).toBe(first);
	retrying.fail();
	expect(expectErr(await retry).name).toBe('StorageFailed');
	const [second] = folder.getStatus().failures;
	if (second === undefined) throw new Error('Expected the retry failure');
	expect(second).not.toBe(first);
	expect(second.error).toBe(first.error);
	expect(edit.getSnapshot().content?.text).toBe('\uFEFFD\r\n');
});

test.each(['discard', 'retry'] as const)(
	'a status listener that starts %s prevents later listeners receiving the superseded failure',
	async (action) => {
		const { folder, hold } = setup({ 'a.md': 'A\n' });
		const edit = folder.files.edit('a.md');
		expectOk(await edit.refresh());
		expectOk(edit.replaceText('B\n'));
		let acted = false;
		let retry: ReturnType<typeof edit.save> | undefined;
		cleanup.push(
			folder.onStatusChange((status) => {
				if (acted || status.failures.length === 0) return;
				acted = true;
				if (action === 'discard') edit.discard();
				else retry = edit.save();
			}),
		);
		const noticed: unknown[] = [];
		cleanup.push(
			folder.onStatusChange((status) => noticed.push(...status.failures)),
		);
		const failing = hold('write');
		const saving = edit.save();
		await failing.reached;
		failing.fail();
		expectErr(await saving);
		if (retry !== undefined) expectOk(await retry);
		expect(acted).toBe(true);
		expect(noticed).toEqual([]);
	},
);

test('discard fences an admitted retry from newer input and a later success clears failure', async () => {
	const { folder, hold } = setup({ 'a.md': 'A\n' });
	const edit = folder.files.edit('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replaceText('failed\n'));
	const first = hold('write');
	const failed = edit.save();
	await first.reached;
	first.fail();
	expectErr(await failed);

	const retrying = hold('write');
	const retry = edit.save();
	await retrying.reached;
	expect(edit.discard()).toBe('failed\n');
	expectOk(edit.replaceText('newer\n'));
	retrying.fail();
	expectErr(await retry);
	expect(edit.getSnapshot().content?.text).toBe('newer\n');
	expect(edit.getSnapshot().saveError).toBeUndefined();

	const failingNewer = hold('write');
	const newerSave = edit.save();
	await failingNewer.reached;
	failingNewer.fail();
	expectErr(await newerSave);
	expect(edit.getSnapshot().saveError?.name).toBe('StorageFailed');
	expectOk(await edit.save());
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'newer\n' },
		isDirty: false,
		saveError: undefined,
	});
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

test.each(['success', 'failure'] as const)(
	'a cold refresh acquires text while a later write awaits %s',
	async (outcome) => {
		const { folder, hold } = setup({ 'a.md': 'observed\n' });
		const edit = folder.files.edit('a.md');
		const reading = hold('read');
		const refreshing = edit.refresh();
		await reading.reached;
		const writing = hold('write');
		const publishing = folder.files.write('a.md', 'later\n');
		await writing.reached;
		reading.proceed();
		expectOk(await refreshing);
		expect(edit.getSnapshot()).toMatchObject({
			content: { text: 'observed\n' },
			isDirty: false,
			isSaving: true,
			loadError: undefined,
		});
		if (outcome === 'success') {
			writing.proceed();
			expectOk(await publishing);
		} else {
			writing.fail();
			expectErr(await publishing);
		}
		expect(edit.getSnapshot()).toMatchObject({
			content: { text: outcome === 'success' ? 'later\n' : 'observed\n' },
			isDirty: false,
			isSaving: false,
		});
	},
);

test('a refresh is answered by a read that started after it, and a change reported meanwhile is read again', async () => {
	const { folder, hold, outside, reads } = setup({ 'a.md': 'old\n' });
	const edit = folder.files.edit('a.md');
	const first = hold('read');
	const { seen } = record(edit);
	await first.reached;
	// The subscription's read is running: it predates the refresh.
	const second = hold('read');
	let settled = false;
	const refreshing = edit.refresh().finally(() => {
		settled = true;
	});
	outside('a.md', 'new\n');
	first.proceed();
	await second.reached;
	await flush();
	expect(settled).toBe(false);
	second.proceed();
	expectOk(await refreshing);
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'new\n' },
		loadError: undefined,
	});
	expect(reads()).toHaveLength(2);
	// The overtaken answer showed first; nothing older followed the newer one.
	expect(seen.map((snapshot: EditorSnapshot) => snapshot.content?.text)).toEqual(
		[undefined, 'old\n', 'new\n'],
	);
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

test('close releases synchronously with a blocked write and never submits held input', async () => {
	const { folder, engine, text, hold, writes } = setup({}, 10);
	let closes = 0;
	const release = engine.close;
	engine.close = () => {
		closes++;
		release();
	};
	const edit = folder.files.edit('held.md');
	expectOk(edit.replaceText('held'));
	const { seen } = record(edit);
	const receipt = folder.files.edit('receipt.md');
	expectErr(await receipt.refresh());
	const receiptSnapshots = record(receipt).seen;
	const statuses: boolean[] = [];
	let changes = 0;
	folder.onStatusChange((status) => statuses.push(status.closing));
	folder.onChange(() => changes++);
	const held = hold('write');
	const writing = folder.files.write('receipt.md', 'sent');
	await held.reached;
	try {
		expect(folder.close()).toBeUndefined();
		expect(closes).toBe(1);
		expect(folder.close()).toBeUndefined();
		expect(closes).toBe(1);
		expect(statuses.filter(Boolean)).toEqual([true]);
		expect(expectErr(edit.replaceText('late')).name).toBe('Closing');
		expect(expectErr(await edit.save()).name).toBe('Closed');
		expect(() => folder.flush()).toThrow('The folder is closed');
		const counts = [
			seen.length,
			receiptSnapshots.length,
			statuses.length,
			changes,
		];
		held.proceed();
		expectOk(await writing);
		await sleep(30);
		expect([
			seen.length,
			receiptSnapshots.length,
			statuses.length,
			changes,
		]).toEqual(counts);
		expect(text('held.md')).toBeUndefined();
		expect(writes()).toEqual(['write receipt.md sent']);
		expect(folder.getStatus().saving).toBe(false);
	} finally {
		held.proceed();
		await writing;
	}
});

test('close from a publication notice suppresses later change listeners', async () => {
	const fake = fakeEngine({ 'a.md': 'before\n' });
	// No engine notice: the handle announces the committed command itself,
	// before the edit owner acknowledges the input it captured.
	const folder = folderHandle(
		{ ...fake.engine, subscribe: () => () => {} },
		{ notes },
		{ saveAfterMs: 60_000 },
	);
	cleanup.push(() => folder.close());
	const edit = folder.files.edit('a.md');
	expectOk(edit.replaceText('saved\n'));
	let notices = 0;
	let later = 0;
	folder.onChange(() => {
		notices++;
		folder.close();
		folder.close();
	});
	folder.onChange(() => later++);
	expectOk(await edit.save());
	expect(notices).toBe(1);
	expect(later).toBe(0);
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(fake.text('a.md')).toBe('saved\n');
});

test('close refuses new storage calls and editor saves while an admitted write is pending', async () => {
	const { folder, hold, text, reads, writes } = setup({
		'accepted.md': 'before',
	});
	const edit = folder.files.edit('accepted.md');
	expectOk(await edit.refresh());
	const held = hold('write');
	const writing = folder.files.write('accepted.md', 'after');
	await held.reached;
	const closing = folder.close();
	try {
		expect(() => folder.files.write('late.md', 'late')).toThrow(
			'The folder is closed',
		);
		expect(() => folder.files.delete('accepted.md')).toThrow(
			'The folder is closed',
		);
		expect(() => folder.tables.notes.set('late', { body: 'late' })).toThrow(
			'The folder is closed',
		);
		expect(() => folder.tables.notes.delete('late')).toThrow(
			'The folder is closed',
		);
		await expect(folder.files.read('accepted.md')).rejects.toThrow(
			'The folder is closed',
		);
		expect(() => folder.files.list()).toThrow('The folder is closed');
		await expect(folder.tables.notes.get('late')).rejects.toThrow(
			'The folder is closed',
		);
		await expect(folder.tables.notes.list()).rejects.toThrow(
			'The folder is closed',
		);
		expect(expectErr(await edit.save()).name).toBe('Closed');
		expect(expectErr(await edit.refresh()).name).toBe('ReadFailed');
		expect(expectErr(edit.replaceText('too late')).name).toBe('Closing');
		record(edit).stop();
		expect(reads()).toEqual(['read accepted.md']);
	} finally {
		held.proceed();
	}
	expectOk(await writing);
	expect(closing).toBeUndefined();
	expect(text('accepted.md')).toBe('after');
	expect(writes()).toEqual(['write accepted.md after']);
});

test('a refresh waiting when the folder closes reports the close and starts no further read', async () => {
	const { folder, hold, outside, reads } = setup({ 'a.md': 'before\n' });
	const edit = folder.files.edit('a.md');
	const held = hold('read');
	const reading = edit.refresh();
	await held.reached;
	outside('a.md', 'changed\n');
	// A second refresh waits for the next read, which close prevents.
	const later = edit.refresh();
	try {
		folder.close();
	} finally {
		held.proceed();
	}
	// Neither read answered: each reports the close, as a refresh after it does.
	for (const refreshing of [reading, later]) {
		const answered = expectErr(await refreshing);
		expect(answered.name).toBe('ReadFailed');
		expect(answered.message).toContain('The folder is closed');
	}
	expect(reads()).toEqual(['read a.md']);
});

test('flush submits held and failed input immediately without waiting', async () => {
	const { folder, hold, text } = setup();
	const a = folder.files.edit('a.md');
	const b = folder.files.edit('b.md');
	expectOk(a.replaceText('A'));
	const failing = hold('write');
	const saving = a.save();
	await failing.reached;
	failing.fail();
	expectErr(await saving);
	expect(folder.getStatus().failures).toHaveLength(1);
	expectOk(b.replaceText('B'));
	const blocked = hold('write');
	try {
		expect(folder.flush()).toBeUndefined();
		await blocked.reached;
		expect(folder.getStatus().saving).toBe(true);
	} finally {
		blocked.proceed();
	}
	await flush();
	expect(text('a.md')).toBe('A');
	expect(text('b.md')).toBe('B');
	expect(folder.getStatus().failures).toEqual([]);
});

test('subscribe after close reports one current snapshot and installs no listener or read', async () => {
	const { folder, hold, reads } = setup();
	const edit = folder.files.edit('a.md');
	expectOk(edit.replaceText('A'));
	const blocked = hold('write');
	const saving = edit.save();
	await blocked.reached;
	try {
		folder.close();
		const { seen, stop } = record(edit);
		expect(seen).toEqual([edit.getSnapshot()]);
		blocked.proceed();
		expectOk(await saving);
		expect(seen).toHaveLength(1);
		expect(reads()).toEqual([]);
		stop();
	} finally {
		blocked.proceed();
		await saving;
	}
});

test('closing during status dispatch suppresses remaining listeners of that dispatch', async () => {
	const { folder } = setup();
	const later: boolean[] = [];
	folder.onStatusChange((status) => {
		if (!status.closing) folder.close();
	});
	folder.onStatusChange((status) => later.push(status.closing));
	expectOk(await folder.files.write('a.md', 'A'));
	// B receives the nested close notification, but never the interrupted open status.
	expect(later).toEqual([true]);
});

test('over the browser engine an editor saves automatically and learns of another handle through a listing', async () => {
	globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
	const folder = expectOk(
		await openFolder({ tables: { notes }, saveAfterMs: 5 }),
	);
	cleanup.push(() => folder.close());
	const other = expectOk(await openFolder({ tables: { notes } }));
	cleanup.push(() => other.close());
	expectOk(await other.tables.notes.write('a', { fields: { title: 'A' } }));
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
	expectOk(
		await other.tables.notes.write('a', { fields: { title: 'Theirs' } }),
	);
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

test('lists return stored rows without acquiring working documents', async () => {
	const { folder, reads } = setup({
		'notes/a.md': row('A', 'one\n'),
		'notes/b.md': row('B', 'two\n'),
	});
	expect(
		expectOk(await folder.tables.notes.list()).map((found) => found.id),
	).toEqual(['a', 'b']);
	const edit = folder.tables.notes.edit('a');
	expect(edit.getSnapshot().content).toBeUndefined();
	expect(
		expectErr(await folder.tables.notes.set('a', { body: 'refused' })).name,
	).toBe('NoContent');
	expect(reads()).toEqual([]);
	const { stop } = record(edit);
	await flush();
	stop();
	expect(reads()).toEqual(['read notes/a.md']);
	expect(edit.getSnapshot().content?.text).toBe(row('A', 'one\n'));
	expect(folder.tables.notes.edit('b').getSnapshot().content).toBeUndefined();
});

test('row gets return data and errors without changing working documents', async () => {
	const { folder, hold, disk } = setup({ 'notes/a.md': row('A', 'one\n') });
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.change({ body: 'typed\n' }));
	const before = edit.getSnapshot();
	disk.set('notes/a.md', encode(row('Outside', 'outside\n')));
	expect(expectOk(await folder.tables.notes.get('a'))?.fields).toEqual({
		title: 'Outside',
	});
	expect(expectOk(await folder.tables.notes.get('gone'))).toBeUndefined();
	expect(
		folder.tables.notes.edit('gone').getSnapshot().loadError,
	).toBeUndefined();
	const failing = hold('get');
	const getting = folder.tables.notes.get('a');
	await failing.reached;
	failing.fail();
	expectErr(await getting);
	expect(edit.getSnapshot()).toBe(before);
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
	// Nothing is left to send: flush and close write nothing more.
	expect(folder.flush()).toBeUndefined();
	folder.close();
	expect(writes()).toEqual([`write notes/a.md ${row('New', 'Typed\n')}`]);
});

test('a failed set retains the accepted patch and reports its save error until explicit retry', async () => {
	const { folder, hold, writes } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.change({ body: 'Typed\n' }));
	const failing = hold('write');
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	expect(edit.getSnapshot().content?.text).toBe(row('New', 'Typed\n'));
	await failing.reached;
	failing.fail();
	const error = expectErr(await setting);
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		saveError: error,
		content: { text: row('New', 'Typed\n') },
	});
	await flush();
	expect(writes()).toEqual([]);
	expectOk(await edit.save());
	expect(writes()).toEqual([`write notes/a.md ${row('New', 'Typed\n')}`]);
});

test('typing during a set builds on its metadata and the result describes its captured row', async () => {
	const { folder, hold, text } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.change({ body: 'B\n' }));
	const writing = hold('write');
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	await writing.reached;
	expect(edit.getSnapshot().content?.text).toBe(row('New', 'B\n'));
	expectOk(edit.change({ body: 'C\n' }));
	writing.proceed();
	expect(expectOk(await setting).text).toBe(row('New', 'B\n'));
	expect(text('notes/a.md')).toBe(row('New', 'B\n'));
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { text: row('New', 'C\n') },
	});
	expectOk(await edit.save());
	expect(text('notes/a.md')).toBe(row('New', 'C\n'));
});

test('a cold set refuses without reading or publishing even behind a pending raw write', async () => {
	const { folder, hold, reads, text } = setup({
		'notes/a.md': row('Old', 'Original\n'),
	});
	const writing = hold('write');
	const written = folder.files.write('notes/a.md', row('Raw', 'Written\n'));
	await writing.reached;
	expect(
		expectErr(await folder.tables.notes.set('a', { fields: { title: 'Set' } }))
			.name,
	).toBe('NoContent');
	for (const legacyId of ['', 'a: b'])
		expect(
			expectErr(await folder.tables.notes.set(legacyId, { body: 'x' })).name,
		).toBe('NoContent');
	expect(reads()).toEqual([]);
	writing.proceed();
	expectOk(await written);
	// Explicit acquisition supplies text; the refused set acquired nothing.
	expectOk(await folder.tables.notes.edit('a').refresh());
	expect(
		expectOk(await folder.tables.notes.set('a', { fields: { title: 'Set' } }))
			.text,
	).toBe(row('Set', 'Written\n'));
	expect(text('notes/a.md')).toBe(row('Set', 'Written\n'));
	expect(
		expectErr(await folder.tables.notes.write('../bad', { body: 'x' })).name,
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

test('raw reads never decode or change editor sources', async () => {
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
	expect(edit.getSnapshot().content?.text).toBe('A\n');
	// The raw read itself answered; the editor did not read again.
	expect(reads().length).toBe(before + 1);
});

test('a file that keeps changing shows each newer answer, settles a refresh, and is read until one applies', async () => {
	const { folder, hold, outside, reads } = setup({ 'a.md': '0' });
	const edit = folder.files.edit('a.md');
	const first = hold('read');
	const { stop } = record(edit);
	cleanup.push(stop);
	await first.reached;
	let settled = false;
	const refreshing = edit.refresh().finally(() => {
		settled = true;
	});
	let held = first;
	for (let change = 1; change <= 8; change++) {
		const next = hold('read');
		outside('a.md', String(change));
		held.proceed();
		await next.reached;
		held = next;
		// Each overtaken answer shows, never one older than the last shown.
		expect(edit.getSnapshot()).toMatchObject({
			content: { text: String(change - 1) },
			loadError: undefined,
		});
		// The first read predates the refresh; the second one answers it.
		expect(settled).toBe(change >= 2);
	}
	expectOk(await refreshing);
	held.proceed();
	await flush();
	expect(edit.getSnapshot().content?.text).toBe('8');
	expect(reads()).toHaveLength(9);
	await flush();
	expect(reads()).toHaveLength(9);
});

test('while a file keeps changing, pending input stays shown and dirty, and load errors stay truthful', async () => {
	const { folder, hold, outside } = setup({ 'a.md': 'v0\n' });
	const edit = folder.files.edit('a.md');
	const { stop } = record(edit);
	cleanup.push(stop);
	await flush();
	// The file goes missing: a read that applies reports it, text retained.
	outside('a.md', null);
	await flush();
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'v0\n' },
		loadError: { name: 'Missing' },
	});
	// It comes back and keeps changing faster than reads return.
	let held = hold('read');
	outside('a.md', 'v1\n');
	await held.reached;
	const next = hold('read');
	outside('a.md', 'v2\n');
	held.proceed();
	await next.reached;
	// The overtaken text is newer than the Missing answer, which it supersedes.
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'v1\n' },
		loadError: undefined,
		isDirty: false,
	});
	expectOk(edit.replaceText('typed\n'));
	held = hold('read');
	outside('a.md', 'v3\n');
	next.proceed();
	await held.reached;
	// Overtaken reads never replace accepted input.
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'typed\n' },
		isDirty: true,
	});
	// A briefly missing file that an overtaking change brings back reports nothing.
	const last = hold('read');
	outside('a.md', null);
	held.proceed();
	await last.reached;
	outside('a.md', 'v4\n');
	last.proceed();
	await flush();
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'typed\n' },
		loadError: undefined,
		isDirty: true,
	});
	expect(folder.files.edit('a.md').getSnapshot().content?.text).toBe('typed\n');
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
	// Lists do not acquire editor text: each visible editor reads its path.
	expect(reads()).toEqual(['read notes/a.md', 'read other.md']);
	await folder.refresh([]);
	expect(reads()).toHaveLength(2);
	disk.set('notes/a.md', encode(row('A2', 'a\n')));
	disk.set('notes/b.md', encode(row('B2', 'b\n')));
	await folder.refresh(['notes/']);
	expect(reads()).toEqual([
		'read notes/a.md',
		'read other.md',
		'read notes/a.md',
	]);
	expect(watched.getSnapshot().content?.fields).toEqual({ title: 'A2' });
	expect(resting.getSnapshot().content).toBeUndefined();
	// The resting editor reads once it is subscribed again.
	cleanup.push(record(resting).stop);
	await flush();
	expect(resting.getSnapshot().content?.fields).toEqual({ title: 'B2' });
	await folder.refresh();
	expect(reads().filter((entry) => entry === 'read other.md')).toHaveLength(2);
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

const draftRow = (draft: boolean, body: string) =>
	draft
		? `---\ntitle: T\ndraft: true\n---\n${body}`
		: `---\ntitle: T\n---\n${body}`;

test('close during a direct promotion never queues the input that promotion captured', async () => {
	const { folder, hold, text, writes } = setup();
	expectOk(
		await folder.tables.notes.write('a', {
			fields: { title: 'T', draft: true } as never,
			body: 'raw\n',
		}),
	);
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
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
	expect(closing).toBeUndefined();
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
	// The later save still owns the input: flush submits nothing behind it.
	const settling = folder.flush();
	await second.reached;
	second.proceed();
	expectOk(await saving);
	expect(settling).toBeUndefined();
	expect(writes()).toEqual([`write notes/a.md ${row('New', 'I\n')}`]);
	// The last owner failing does give it back, for a later explicit save or flush.
	expectOk(edit.replaceText(row('Old', 'J\n')));
	const failing = hold('write');
	const failed = folder.tables.notes.set('a', { fields: { title: 'Newer' } });
	await failing.reached;
	failing.fail();
	await failed;
	expectOk(await edit.save());
	folder.close();
	expect(writes().at(-1)).toBe(`write notes/a.md ${row('Newer', 'J\n')}`);
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
	expect(closing).toBeUndefined();
	expect(text('a.md')).toBe('raw\n');
	expect(writes()).toEqual(['write a.md raw\n']);
});

test('a failed set after close retains its accepted edit without retrying', async () => {
	const { folder, hold, text, writes } = setup({
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
	expect(closing).toBeUndefined();
	expect(edit.getSnapshot().content?.text).toBe(row('New', 'I\n'));
	expect(edit.getSnapshot().isDirty).toBe(true);
	expect(text('notes/a.md')).toBe(row('Old', 'Original\n'));
	expect(writes()).toEqual([]);
});

test('failed raw replacement followed by failed set leaves only the accepted set pending', async () => {
	const { folder, hold, writes, text } = setup({
		'notes/a.md': row('Old', 'original\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.change({ body: 'input\n' }));
	const first = hold('write');
	const second = hold('write');
	const raw = folder.files.write('notes/a.md', row('Raw', 'command\n'));
	const set = folder.tables.notes.set('a', { fields: { title: 'Set' } });
	await first.reached;
	first.fail();
	expectErr(await raw);
	await second.reached;
	second.fail();
	expectErr(await set);
	await flush();
	expect(writes()).toEqual([]);
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		isSaving: false,
		saveError: { name: 'StorageFailed' },
		content: { text: row('Set', 'input\n') },
	});
	expectOk(await edit.save());
	expect(text('notes/a.md')).toBe(row('Set', 'input\n'));
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
	writing.proceed();
	expectOk(await setting);
	expectOk(await edit.save());
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
		saveError: { name: 'StorageFailed' },
		content: { text: row('New', 'Typed\n') },
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

test('an admitted command that throws after close resolves with StorageFailed', async () => {
	const fake = fakeEngine();
	const blocked = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	fake.engine.files.write = async () => {
		reached.resolve();
		await blocked.promise;
		throw new Error('released storage');
	};
	const folder = folderHandle(fake.engine, {});
	const writing = folder.files.write('a.md', 'A');
	await reached.promise;
	try {
		folder.close();
		blocked.resolve();
		expect(expectErr(await writing).name).toBe('StorageFailed');
		expect(folder.getStatus().saving).toBe(false);
	} finally {
		blocked.resolve();
		await writing;
		folder.close();
	}
});

test('a set admits its captured publication before a reentrant observer edits and saves', async () => {
	const { folder, hold, text, writes } = setup({
		'notes/a.md': row('Old', 'B\n'),
	});
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	const blocked = hold('write');
	let later: ReturnType<typeof edit.save> | undefined;
	const stop = edit.subscribe((snapshot) => {
		if (
			snapshot.content?.fields?.title !== 'New' ||
			snapshot.content?.body !== 'B\n'
		)
			return;
		expect(snapshot.isSaving).toBe(true);
		expectOk(edit.change({ body: 'C\n' }));
		later = edit.save();
	});
	const setting = folder.tables.notes.set('a', { fields: { title: 'New' } });
	await blocked.reached;
	expect(later).toBeDefined();
	blocked.proceed();
	expect(expectOk(await setting).text).toBe(row('New', 'B\n'));
	expectOk(await later!);
	stop();
	expect(text('notes/a.md')).toBe(row('New', 'C\n'));
	expect(writes()).toEqual([
		`write notes/a.md ${row('New', 'B\n')}`,
		`write notes/a.md ${row('New', 'C\n')}`,
	]);
});

test('reentrant status listeners never receive an older status after a newer publication status', async () => {
	const { folder } = setup();
	const edit = folder.files.edit('a.md');
	let saving: ReturnType<typeof edit.save> | undefined;
	folder.onStatusChange((status) => {
		if (status.unsaved.length > 0 && !status.saving && saving === undefined)
			saving = edit.save();
	});
	const seen: boolean[] = [];
	folder.onStatusChange((status) => seen.push(status.saving));
	expectOk(edit.replaceText('A'));
	expect(seen).toEqual([true]);
	expectOk(await saving!);
	// Acknowledgement can publish clean-but-still-settling status before lane release.
	expect(seen).toEqual([true, true, false]);
});

test('table write publishes a complete replacement and reports its exact row despite newer input', async () => {
	const { folder, hold, text } = setup({ 'notes/a.md': row('Old', 'B\n') });
	const edit = folder.tables.notes.edit('a');
	expectOk(await edit.refresh());
	expectOk(edit.change({ body: 'pending\n' }));
	const blocked = hold('write');
	const writing = folder.tables.notes.write('a', { body: 'replacement\n' });
	await blocked.reached;
	expectOk(edit.change({ body: 'newer\n' }));
	blocked.proceed();
	const stored = expectOk(await writing);
	expect(stored.fields).toEqual({});
	expect(stored.body).toBe('replacement\n');
	expect(text('notes/a.md')).toBe(stored.text);
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { text: row('Old', 'newer\n') },
	});
});

test('failed table creation retains no autosave payload and retry writes the same path once', async () => {
	const { folder, hold, writes } = setup();
	const blocked = hold('write');
	const creating = folder.tables.notes.write('new', {
		fields: { title: 'New' },
		body: 'created\n',
	});
	await blocked.reached;
	blocked.fail();
	expectErr(await creating);
	expect(folder.getStatus().unsaved).toEqual([]);
	folder.flush();
	await flush();
	expect(writes()).toEqual([]);
	expect(
		expectOk(
			await folder.tables.notes.write('new', {
				fields: { title: 'New' },
				body: 'created\n',
			}),
		).text,
	).toBe(row('New', 'created\n'));
	expect(writes()).toEqual([`write notes/new.md ${row('New', 'created\n')}`]);
});
