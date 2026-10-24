/**
 * Folder Document Tests
 *
 * Uses a controllable engine to verify one canonical text document per path,
 * synchronous edits, serialized I/O, coalesced autosave, discard, and close.
 */
import { afterEach, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
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

test('one path gives one passive text document across file and table access', async () => {
	const { folder, reads } = setup({
		'notes/a.md': '---\ntitle: A\n---\nbody\n',
	});
	const edit = folder.files.document('notes/a.md');
	const other = Type.Object({ done: Type.Boolean() });
	expect(folder.files.document('notes/a.md')).toBe(edit);
	expect(folder.tables.notes.document('a')).toBe(edit);
	expect(folder.files.document<typeof notes>('notes/a.md')).toBe(edit);
	expect(folder.files.document<typeof other>('notes/a.md')).toBe(edit);
	expect(folder.files.document<typeof notes>('notes/a.md').getSnapshot()).toBe(
		edit.getSnapshot(),
	);
	const first = edit.getSnapshot();
	expect(first).toEqual({
		text: undefined,
		loadError: undefined,
		isDirty: false,
		isSaving: false,
		saveError: undefined,
	});
	expect(edit.getSnapshot()).toBe(first);
	await flush();
	expect(reads()).toEqual([]);
	const { seen, stop } = record(edit);
	expect(seen[0]).toBe(first);
	await flush();
	expect(edit.getSnapshot().text).toBe('---\ntitle: A\n---\nbody\n');
	const loaded = edit.getSnapshot().text;
	if (loaded === undefined) throw new Error('Expected loaded text');
	expect(folder.tables.notes.parse(loaded).fields).toEqual({
		title: 'A',
	});
	stop();
});

test('a synchronous replace is visible before a read or save', async () => {
	const { folder, hold } = setup({ 'a.md': 'disk' });
	const edit = folder.files.document('a.md');
	const gate = hold('read');
	const reading = edit.refresh();
	await gate.reached;
	expectOk(edit.replace('mine'));
	expect(edit.getSnapshot()).toMatchObject({ text: 'mine', isDirty: true });
	gate.proceed();
	expectOk(await reading);
	expect(edit.getSnapshot().text).toBe('mine');
	expect(folder.getStatus().unsaved).toEqual(['a.md']);
});

test('patch composes on full text and table parsing is pure', async () => {
	const { folder } = setup({ 'notes/a.md': 'body\n' });
	const edit = folder.tables.notes.document('a');
	expectOk(await edit.refresh());
	expectOk(edit.patch({ fields: { title: 'New' }, body: 'new body\n' }));
	const text = edit.getSnapshot().text;
	if (text === undefined) throw new Error('Expected edited text');
	expect(text).toContain('title: New');
	expect(folder.tables.notes.parse(text).body).toBe('new body\n');
	expectOk(edit.replace('raw text'));
	expectOk(edit.patch({ body: 'new raw body' }));
	expect(edit.getSnapshot().text).toBe('new raw body');
});

test('malformed frontmatter refuses patch but complete replacement repairs it', async () => {
	const { folder } = setup({ 'notes/a.md': '---\ntitle: [\n---\nbody' });
	const edit = folder.tables.notes.document('a');
	expectOk(await edit.refresh());
	expect(expectErr(edit.patch({ body: 'changed' })).name).toBe(
		'MalformedFrontmatter',
	);
	expectOk(edit.replace('---\ntitle: Repaired\n---\nbody'));
	expectOk(edit.patch({ body: 'changed' }));
});

test('explicit save publishes its captured text while a later edit stays dirty', async () => {
	const { folder, hold, text } = setup();
	const edit = folder.files.document('a.md');
	expectOk(edit.replace('first'));
	const gate = hold('write');
	const first = edit.save();
	await gate.reached;
	expectOk(edit.replace('second'));
	expect(edit.getSnapshot()).toMatchObject({
		text: 'second',
		isDirty: true,
		isSaving: true,
	});
	gate.proceed();
	expectOk(await first);
	expect(text('a.md')).toBe('first');
	expect(edit.getSnapshot().text).toBe('second');
	expect(edit.getSnapshot().isDirty).toBe(true);
});

test('two explicit saves each publish their own captured value in call order', async () => {
	const { folder, hold, writes, text } = setup();
	const edit = folder.files.document('a.md');
	const gate = hold('write');
	expectOk(edit.replace('one'));
	const first = edit.save();
	await gate.reached;
	expectOk(edit.replace('two'));
	const second = edit.save();
	gate.proceed();
	expectOk(await first);
	expectOk(await second);
	expect(writes()).toEqual(['write a.md one', 'write a.md two']);
	expect(text('a.md')).toBe('two');
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('autosave coalesces later edits while an earlier save is busy', async () => {
	const { folder, hold, writes, text } = setup({}, 0);
	const edit = folder.files.document('a.md');
	const gate = hold('write');
	expectOk(edit.replace('one'));
	await gate.reached;
	expectOk(edit.replace('two'));
	expectOk(edit.replace('three'));
	await flush();
	gate.proceed();
	await flush();
	expect(writes()).toEqual(['write a.md one', 'write a.md three']);
	expect(text('a.md')).toBe('three');
});

test('a raw delete cancels a pending autosave and shows missing after settlement', async () => {
	const { folder, writes } = setup({ 'a.md': 'old' }, 5);
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replace('draft'));
	expectOk(await folder.files.delete('a.md'));
	await sleep(15);
	expect(writes()).toEqual(['delete a.md']);
	expect(edit.getSnapshot().text).toBeUndefined();
	expect(edit.getSnapshot().loadError?.name).toBe('Missing');
});

test('a raw delete after an inflight save runs later and does not resurrect the file', async () => {
	const { folder, hold, writes, text } = setup();
	const edit = folder.files.document('a.md');
	expectOk(edit.replace('draft'));
	const gate = hold('write');
	const saving = edit.save();
	await gate.reached;
	const deleting = folder.files.delete('a.md');
	gate.proceed();
	expectOk(await saving);
	expectOk(await deleting);
	expect(writes()).toEqual(['write a.md draft', 'delete a.md']);
	expect(text('a.md')).toBeUndefined();
	expect(edit.getSnapshot().text).toBeUndefined();
});

test('discard during inflight save restores the admitted text without cancelling it', async () => {
	const { folder, hold, text } = setup({ 'a.md': 'base' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replace('saved'));
	const gate = hold('write');
	const saving = edit.save();
	await gate.reached;
	expectOk(edit.replace('later'));
	expect(edit.discard()).toBe('later');
	expect(edit.getSnapshot().text).toBe('saved');
	gate.proceed();
	expectOk(await saving);
	expect(text('a.md')).toBe('saved');
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('failed explicit save retains draft and exact failure object for retry', async () => {
	const { folder, hold, writeError } = setup();
	const edit = folder.files.document('a.md');
	expectOk(edit.replace('draft'));
	const gate = hold('write');
	const saving = edit.save();
	await gate.reached;
	gate.fail();
	const failure = expectErr(await saving);
	expect(failure).toBe(writeError);
	expect(edit.getSnapshot().saveError).toBe(writeError);
	expect(folder.getStatus().failures[0]?.error).toBe(writeError);
	expect(edit.getSnapshot().isDirty).toBe(true);
	expectOk(await edit.save());
	expect(edit.getSnapshot().saveError).toBeUndefined();
});

test('reads, writes, and deletes share one path slot while other paths proceed', async () => {
	const { folder, hold, log } = setup({ 'a.md': 'A', 'b.md': 'B' });
	const gate = hold('read');
	const a = folder.files.document('a.md');
	const reading = a.refresh();
	await gate.reached;
	const writing = folder.files.write('a.md', 'new A');
	expectOk(await folder.files.write('b.md', 'new B'));
	expect(log).toContain('write b.md new B');
	expect(log).not.toContain('write a.md new A');
	gate.proceed();
	expectOk(await reading);
	expectOk(await writing);
	expect(log.indexOf('read a.md')).toBeLessThan(
		log.indexOf('write a.md new A'),
	);
});

test('close drops queued autosave, lets the started fake write settle, and refuses queued reads', async () => {
	const { folder, hold, writes } = setup({}, 5);
	const edit = folder.files.document('a.md');
	expectOk(edit.replace('admitted'));
	const gate = hold('write');
	const saving = edit.save();
	await gate.reached;
	expectOk(edit.replace('not admitted'));
	const reading = edit.refresh();
	folder.close();
	gate.proceed();
	expectOk(await saving);
	expect(expectErr(await reading).name).toBe('ReadFailed');
	await sleep(15);
	expect(writes()).toEqual(['write a.md admitted']);
	expect(edit.getSnapshot().text).toBe('not admitted');
	expect(expectErr(await edit.save()).name).toBe('Closing');
});

test('outside change replaces clean text but preserves dirty text', async () => {
	const { folder, outside } = setup({ 'a.md': 'old' });
	const edit = folder.files.document('a.md');
	const { stop } = record(edit);
	await flush();
	outside('a.md', 'external');
	await flush();
	expect(edit.getSnapshot().text).toBe('external');
	expectOk(edit.replace('mine'));
	outside('a.md', 'new disk');
	await flush();
	expect(edit.getSnapshot().text).toBe('mine');
	stop();
});

test.each([
	['missing', null, 'Missing'],
	['not text', new Uint8Array([0xff, 0]), 'NotText'],
] as const)(
	'an outside %s observation keeps the last readable text for explicit restoration',
	async (_, replacement, errorName) => {
		const { folder, outside, text } = setup({ 'a.md': 'last readable' });
		const edit = folder.files.document('a.md');
		const { stop } = record(edit);
		await flush();
		outside('a.md', replacement);
		await flush();
		expect(edit.getSnapshot().text).toBe('last readable');
		expect(edit.getSnapshot().loadError?.name).toBe(errorName);
		expect(edit.getSnapshot().isDirty).toBe(false);
		expectOk(await edit.save());
		expect(text('a.md')).toBe('last readable');
		expect(edit.getSnapshot().loadError).toBeUndefined();
		stop();
	},
);

test('an inactive document keeps its last text through a change hint and missing read', async () => {
	const { folder, outside } = setup({ 'a.md': 'last readable' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	outside('a.md', null);
	expect(edit.getSnapshot().text).toBe('last readable');
	expect(edit.getSnapshot().loadError).toBeUndefined();
	expect(expectErr(await edit.refresh()).name).toBe('Missing');
	expect(edit.getSnapshot().text).toBe('last readable');
	expect(edit.getSnapshot().loadError?.name).toBe('Missing');
});

test('a failure finishing after discard does not reattach to the document', async () => {
	const { folder, hold } = setup({ 'a.md': 'old' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replace('new'));
	const gate = hold('write');
	const saving = edit.save();
	await gate.reached;
	expect(edit.discard()).toBe('new');
	gate.fail();
	expect(expectErr(await saving).name).toBe('StorageFailed');
	expect(edit.getSnapshot().saveError).toBeUndefined();
	expect(folder.getStatus().failures).toEqual([]);
});

test('a binary replacement reports NotText and does not reuse old text', async () => {
	const { folder } = setup({ 'a.md': 'text' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	expectOk(await folder.files.write('a.md', new Uint8Array([0xff, 0x00])));
	expect(edit.getSnapshot().text).toBeUndefined();
	expect(edit.getSnapshot().loadError?.name).toBe('NotText');
	expectOk(edit.replace('new text'));
	expect(edit.getSnapshot().text).toBe('new text');
	expectOk(await edit.save());
	expect(edit.getSnapshot().loadError).toBeUndefined();
});

test('folder status follows pending writes without demanding document content', async () => {
	const { folder, hold, reads } = setup();
	const statuses: string[][] = [];
	const stop = folder.onStatusChange((status) =>
		statuses.push([...status.savingPaths]),
	);
	const gate = hold('write');
	const a = folder.files.write('a.md', 'A');
	await gate.reached;
	const b = folder.files.write('b.md', 'B');
	expect(folder.getStatus().savingPaths).toEqual(['a.md', 'b.md']);
	expect(reads()).toEqual([]);
	gate.proceed();
	expectOk(await a);
	expectOk(await b);
	expect(folder.getStatus().savingPaths).toEqual([]);
	expect(statuses.some((paths) => paths.length === 2)).toBe(true);
	stop();
});

test('a reported outside edit during a read triggers another read', async () => {
	const { folder, hold, outside, reads } = setup({ 'a.md': 'first' });
	const edit = folder.files.document('a.md');
	const gate = hold('read');
	const { stop } = record(edit);
	await gate.reached;
	outside('a.md', 'second');
	gate.proceed();
	await flush();
	expect(reads()).toEqual(['read a.md', 'read a.md']);
	expect(edit.getSnapshot().text).toBe('second');
	stop();
});

test('structurally invalid paths and row ids fail before acquiring a document', () => {
	const { folder, reads } = setup();
	expect(() => folder.files.document('../outside')).toThrow(RangeError);
	expect(() => folder.tables.notes.document('a/b')).toThrow(RangeError);
	expect(reads()).toEqual([]);
});

test('a failed raw delete retains the draft for autosave or retry', async () => {
	const { folder, hold, text } = setup({ 'a.md': 'base' }, 60_000);
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replace('draft'));
	const gate = hold('delete');
	const deleting = folder.files.delete('a.md');
	await gate.reached;
	gate.fail();
	expect(expectErr(await deleting).name).toBe('StorageFailed');
	expect(edit.getSnapshot().text).toBe('draft');
	expect(edit.getSnapshot().isDirty).toBe(true);
	expect(text('a.md')).toBe('base');
	expectOk(await edit.save());
	expect(text('a.md')).toBe('draft');
});

test('a late failure stays with the draft that admitted it, not a later draft', async () => {
	const { folder, hold } = setup({ 'a.md': 'base' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replace('first'));
	const gate = hold('write');
	const first = edit.save();
	await gate.reached;
	expect(edit.discard()).toBe('first');
	expectOk(edit.replace('second'));
	gate.fail();
	expect(expectErr(await first).name).toBe('StorageFailed');
	expect(edit.getSnapshot().text).toBe('second');
	expect(edit.getSnapshot().saveError).toBeUndefined();
});

test('an own change notification sees the updated document text', async () => {
	const { folder } = setup({ 'a.md': 'old' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	const seen: (string | undefined)[] = [];
	const stop = folder.onChange(() => seen.push(edit.getSnapshot().text));
	expectOk(await folder.files.write('a.md', 'new'));
	expect(seen).toEqual(['new']);
	stop();
});

test('missing text refuses save and patch until replacement supplies source', async () => {
	const { folder, reads } = setup();
	const edit = folder.files.document('missing.md');
	expect(expectErr(await edit.save()).name).toBe('NoContent');
	expect(expectErr(edit.patch({ body: 'x' })).name).toBe('NoContent');
	expect(reads()).toEqual([]);
	expect(expectErr(await edit.refresh()).name).toBe('Missing');
	expectOk(edit.replace('new'));
	expectOk(await edit.save());
	expect(edit.getSnapshot().loadError).toBeUndefined();
});

test('invalid text and invalid patch input refuse before changing a draft', async () => {
	const { folder } = setup({ 'a.md': 'valid' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	expect(expectErr(edit.replace('bad\0text')).name).toBe('InvalidText');
	expect(expectErr(edit.patch({ body: 'bad\0body' })).name).toBe('InvalidText');
	expect(edit.getSnapshot().text).toBe('valid');
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('status snapshot keeps identity while only document text changes', async () => {
	const { folder } = setup();
	const edit = folder.files.document('a.md');
	const initial = folder.getStatus();
	expectOk(edit.replace('one'));
	const dirty = folder.getStatus();
	expect(dirty).not.toBe(initial);
	expectOk(edit.replace('two'));
	expect(folder.getStatus()).toBe(dirty);
	edit.discard();
	expect(folder.getStatus().unsaved).toEqual([]);
});

test('a subscriber after close receives one cached snapshot and starts no read', async () => {
	const { folder, reads } = setup();
	const edit = folder.files.document('a.md');
	expectOk(edit.replace('draft'));
	folder.close();
	const seen = record(edit);
	expect(seen.seen).toEqual([edit.getSnapshot()]);
	expect(reads()).toEqual([]);
	expect(expectErr(edit.replace('later')).name).toBe('Closing');
});

test('an A to B to A edit stays dirty after queued saves of A and B', async () => {
	const { folder, hold, text, writes } = setup();
	const edit = folder.files.document('a.md');
	expectOk(edit.replace('A'));
	const gate = hold('write');
	const first = edit.save();
	await gate.reached;
	expectOk(edit.replace('B'));
	const second = edit.save();
	expectOk(edit.replace('A'));
	gate.proceed();
	expectOk(await first);
	expectOk(await second);
	expect(writes()).toEqual(['write a.md A', 'write a.md B']);
	expect(text('a.md')).toBe('B');
	expect(edit.getSnapshot()).toMatchObject({ text: 'A', isDirty: true });
	folder.flush();
	await flush();
	expect(text('a.md')).toBe('A');
});

test('one failure wrapper survives edits, hides on exact retry, and changes after retry failure', async () => {
	const { folder, hold, writeError } = setup({ 'a.md': 'base' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	expectOk(edit.replace('first'));
	const firstGate = hold('write');
	const firstSave = edit.save();
	await firstGate.reached;
	firstGate.fail();
	expect(expectErr(await firstSave)).toBe(writeError);
	const [first] = folder.getStatus().failures;
	expect(first?.error).toBe(writeError);
	expect(edit.getSnapshot().saveError).toBe(writeError);
	expectOk(edit.replace('second'));
	expect(folder.getStatus().failures[0]).toBe(first);
	const retryGate = hold('write');
	const retry = edit.save();
	await retryGate.reached;
	expect(folder.getStatus().failures).toEqual([]);
	expect(edit.getSnapshot().saveError).toBeUndefined();
	expectOk(edit.replace('third'));
	expect(folder.getStatus().failures[0]).toBe(first);
	expect(edit.getSnapshot().saveError).toBe(writeError);
	retryGate.fail();
	expect(expectErr(await retry)).toBe(writeError);
	const [second] = folder.getStatus().failures;
	expect(second).not.toBe(first);
	expect(second?.error).toBe(first?.error);
	expectOk(await edit.save());
	expect(folder.getStatus().failures).toEqual([]);
});

test('same text after discard during pending save is accepted as a new draft', async () => {
	const { folder, hold } = setup();
	const edit = folder.files.document('a.md');
	expectOk(edit.replace('A'));
	const gate = hold('write');
	const saving = edit.save();
	await gate.reached;
	expect(edit.discard()).toBe('A');
	expect(edit.getSnapshot()).toMatchObject({ text: 'A', isDirty: false });
	expectOk(edit.replace('A'));
	expect(edit.getSnapshot().isDirty).toBe(true);
	gate.fail();
	expect(expectErr(await saving).name).toBe('StorageFailed');
	expect(edit.getSnapshot()).toMatchObject({
		text: 'A',
		isDirty: true,
		saveError: undefined,
	});
});

for (const outcome of ['succeed', 'fail'] as const) {
	test(`patch composes over a pending raw write when it will ${outcome}`, async () => {
		const { folder, hold, text } = setup({
			'notes/a.md': '---\ntitle: A\n---\nold\n',
		});
		const edit = folder.tables.notes.document('a');
		expectOk(await edit.refresh());
		const gate = hold('write');
		const raw = folder.files.write('notes/a.md', '---\ntitle: B\n---\nbody\n');
		await gate.reached;
		expectOk(edit.patch({ body: 'C\n' }));
		expect(edit.getSnapshot().text).toContain('title: B');
		expect(edit.getSnapshot().text).toEndWith('C\n');
		if (outcome === 'fail') gate.fail();
		else gate.proceed();
		const result = await raw;
		if (outcome === 'fail') {
			expect(expectErr(result).name).toBe('StorageFailed');
			expect(text('notes/a.md')).toContain('title: A');
		} else {
			expectOk(result);
			expect(text('notes/a.md')).toContain('title: B');
		}
		expect(edit.getSnapshot().text).toContain('title: B');
		expect(edit.getSnapshot().text).toEndWith('C\n');
		expect(edit.getSnapshot().isDirty).toBe(true);
	});
}

test('isSaving includes an admitted delete of the document path', async () => {
	const { folder, hold } = setup({ 'a.md': 'old' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	const gate = hold('delete');
	const deleting = folder.files.delete('a.md');
	await gate.reached;
	expect(edit.getSnapshot().isSaving).toBe(true);
	expect(folder.getStatus().savingPaths).toEqual(['a.md']);
	gate.proceed();
	expectOk(await deleting);
	expect(edit.getSnapshot().isSaving).toBe(false);
});

test('raw-only path state is released after settlement unless a listener acquires it', async () => {
	const { folder } = setup();
	expectOk(await folder.files.write('raw.md', 'one'));
	const fresh = folder.files.document('raw.md');
	expect(fresh.getSnapshot().text).toBeUndefined();
	expectOk(await fresh.refresh());
	expect(fresh.getSnapshot().text).toBe('one');
	let acquired: ReturnType<typeof folder.files.document> | undefined;
	const stop = folder.onChange(({ paths }) => {
		if (paths?.includes('other.md'))
			acquired = folder.files.document('other.md');
	});
	expectOk(await folder.files.write('other.md', 'two'));
	expect(acquired).toBe(folder.files.document('other.md'));
	expect(acquired?.getSnapshot().text).toBe('two');
	stop();
});

test('onChange sees a reentrant document edit made by a snapshot listener', async () => {
	const { folder } = setup({ 'a.md': 'old' });
	const edit = folder.files.document('a.md');
	expectOk(await edit.refresh());
	const stopEdit = edit.subscribe((snapshot) => {
		if (snapshot.text === 'new') expectOk(edit.replace('newer'));
	});
	const seen: (string | undefined)[] = [];
	const stopChange = folder.onChange(() => seen.push(edit.getSnapshot().text));
	expectOk(await folder.files.write('a.md', 'new'));
	expect(seen).toEqual(['newer']);
	stopChange();
	stopEdit();
});
