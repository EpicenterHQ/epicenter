/**
 * Folder Edit Owner Tests
 *
 * Drives the edit handles of a real browser folder on an in-memory IndexedDB
 * (`folder.tables.<name>.edit(id)`, `folder.files.edit(path)`), with a second
 * handle standing in for another writer. Each change names the source a view
 * saw, read explicitly; no UI framework or query cache takes part. Engine
 * operations below the handle are intercepted to hold or count saves.
 *
 * Key behaviors:
 * - A change from a view that showed older held input merges into what is
 *   held; one from a view that showed the held input replaces it, a revert
 *   included; the submitted bases prove both
 * - Own saves stay visible to a view whose read started before them, never
 *   to one whose read started after, and no read relabels another value
 * - Whole text composes with earlier own saves; field and body saves too
 * - A change is nested fields and body, taken as one change
 * - The folder owns input from construction: autosave, status, settle and
 *   close work with no view and no subscriber; close waits for saves, not
 *   reads, and answers what did not save
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openRepository } from './browser/repository.js';
import { openFolder } from './browser.js';
import { UNSAVED } from './edits.js';
import type { FolderChange, FolderStatus } from './folder.js';
import type { FolderEngine } from './handle.js';
import { folderHandle } from './handle.js';
import { openFolder as openAutomatic } from './index.js';
import { fileBytes, noteRead, readOf } from './shared/observation.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
/** A table whose rows have a frontmatter field named `body`. */
const letters = Type.Object({ title: Type.String(), body: Type.String() });
const tables = { notes, letters };

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const open = async () => {
	const folder = expectOk(await openFolder({ tables }));
	cleanup.push(() => folder.close());
	return folder;
};

/**
 * The profile's folder over its browser engine, as `openFolder` makes it,
 * with the engine's operations left reachable so a test can hold or count
 * them below the handle.
 */
async function openOverEngine(saveAfterMs = 60_000) {
	const repository = await openRepository('default', tables);
	const engine = {
		files: { ...repository.files },
		tables: {
			notes: { ...repository.tables.notes },
			letters: { ...repository.tables.letters },
		},
		subscribe: repository.onChange,
		close: repository.close,
	} satisfies FolderEngine;
	const folder = folderHandle(engine, tables, { saveAfterMs });
	cleanup.push(() => folder.close());
	return { folder, engine };
}

/** A fresh profile holding `milk`, and another writer. */
async function setup(body = 'Two litres\n', saveAfterMs = 60_000) {
	globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
	const { folder, engine } = await openOverEngine(saveAfterMs);
	expectOk(
		await folder.tables.notes.set('milk', null, {
			fields: { title: 'Milk', done: false },
			body,
		}),
	);
	const other = await open();
	/** The row as a view observes it now. */
	const observe = async () => {
		const row = expectOk(await folder.tables.notes.get('milk'));
		if (row === undefined) throw new Error('milk is not stored');
		return row;
	};
	/** A file's bytes as a view observes them now. */
	const observeFile = async (path: string) => {
		const file = expectOk(await folder.files.read(path));
		if (file === undefined) throw new Error(`${path} is not stored`);
		return fileBytes(file.content);
	};
	/** What is stored at `path`, read by the other writer. */
	const stored = async (path: string) => {
		const file = expectOk(await other.files.read(path));
		return file === undefined
			? undefined
			: decode(await fileBytes(file.content));
	};
	/** Another writer's change, from what it read. */
	const elsewhere = async (change: {
		fields?: Partial<{ title: string; done: boolean }>;
		body?: string;
	}) => {
		const from = expectOk(await other.tables.notes.get('milk'));
		expectOk(await other.tables.notes.set('milk', from ?? null, change));
	};
	return {
		folder,
		engine,
		other,
		edit: folder.tables.notes.edit('milk'),
		observe,
		observeFile,
		stored,
		elsewhere,
	};
}

/** Replace `target[key]` to record each call, holding calls while held. */
function intercept<TTarget extends object, TKey extends keyof TTarget>(
	target: TTarget,
	key: TKey,
) {
	const original = target[key] as unknown as (
		...args: unknown[]
	) => Promise<unknown>;
	const calls: unknown[][] = [];
	let gate: PromiseWithResolvers<void> | undefined;
	let called = Promise.withResolvers<void>();
	target[key] = (async (...args: unknown[]) => {
		calls.push(args);
		called.resolve();
		if (gate !== undefined) await gate.promise;
		return original(...args);
	}) as TTarget[TKey];
	const restore = () => {
		gate?.resolve();
		target[key] = original as TTarget[TKey];
	};
	cleanup.push(restore);
	return {
		calls,
		/** Resolves once the next call starts. */
		next() {
			called = Promise.withResolvers();
			return called.promise;
		},
		hold() {
			gate = Promise.withResolvers();
		},
		release() {
			const held = gate;
			gate = undefined;
			held?.resolve();
		},
		restore,
	};
}

/** Make every IndexedDB write fail the way a full disk does, until restored. */
function fillDisk() {
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	const restore = () => {
		IDBObjectStore.prototype.put = put;
	};
	cleanup.push(restore);
	return restore;
}

/** Wait until `done`, letting timers and promises run between checks. */
async function until(done: () => boolean) {
	for (let turn = 0; turn < 200; turn++) {
		if (done()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('Never happened');
}

// ============================================================================
// Sources
// ============================================================================

test('a field typed back to its original value after an outside change saves that value', async () => {
	const { folder, edit, observe, elsewhere } = await setup();
	edit.change(await observe(), { fields: { title: 'Oat milk' } });
	await elsewhere({ fields: { done: true } });
	const view = edit.shown(await observe());
	expect(view.row.fields.done).toBe(true);

	edit.change(view.source, { fields: { done: false } });
	await edit.save();

	expect(edit.pending).toBeUndefined();
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields).toEqual({
		title: 'Oat milk',
		done: false,
	});
});

test('a body first typed after an outside change starts from it, so a later outside edit of another line survives', async () => {
	const { folder, edit, observe, elsewhere } = await setup('one\ntwo\nthree\n');
	edit.change(await observe(), { fields: { title: 'Oat milk' } });
	await elsewhere({ body: 'ONE\ntwo\nthree\n' });
	const view = edit.shown(await observe());

	edit.change(view.source, { body: 'ONE\ntwo\nthree, typed\n' });
	await elsewhere({ body: 'Uno\ntwo\nthree\n' });
	await edit.save();

	const stored = expectOk(await folder.tables.notes.get('milk'));
	expect(stored?.fields.title).toBe('Oat milk');
	expect(stored?.body).toBe('Uno\ntwo\nthree, typed\n');
});

test('units first typed while a save runs keep the row they were typed over after it lands', async () => {
	const { folder, engine, edit, observe, elsewhere } =
		await setup('one\ntwo\nthree\n');
	const sets = intercept(engine.tables.notes, 'set');
	edit.change(await observe(), { fields: { title: 'Oat milk' } });
	const started = sets.next();
	sets.hold();
	const first = edit.save();
	await started;

	await elsewhere({ fields: { done: true }, body: 'ONE\ntwo\nthree\n' });
	const view = edit.shown(await observe());
	edit.change(view.source, {
		fields: { done: false },
		body: 'ONE\ntwo\nthree, typed\n',
	});
	sets.release();
	await first;
	expect(edit.pending?.fields).toEqual({ done: false });

	await elsewhere({ body: 'Uno\ntwo\nthree\n' });
	await edit.save();
	const stored = expectOk(await folder.tables.notes.get('milk'));
	expect(stored?.fields).toEqual({ title: 'Oat milk', done: false });
	expect(stored?.body).toBe('Uno\ntwo\nthree, typed\n');
	expect(edit.pending).toBeUndefined();
});

test('typing that continues a sent field starts from what the save sent', async () => {
	const { folder, engine, edit, observe, elsewhere } = await setup();
	const sets = intercept(engine.tables.notes, 'set');
	edit.change(await observe(), { fields: { title: 'Oat' } });
	const started = sets.next();
	sets.hold();
	const first = edit.save();
	await started;
	const view = edit.shown(await observe());
	expect(view.row.fields.title).toBe('Oat');
	edit.change(view.source, { fields: { title: 'Oat milk' } });
	sets.release();
	await first;

	await elsewhere({ fields: { done: true } });
	await edit.save();
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields).toEqual({
		title: 'Oat milk',
		done: true,
	});
});

test('a body typed over broken frontmatter saves with a field typed after the frontmatter was repaired', async () => {
	const { folder, edit, observe, stored } = await setup();
	const path = 'notes/milk.md';
	const repaired = '---\ntitle: Milk\ndone: false\n---\nTwo litres\n';
	expectOk(
		await folder.files.write(
			path,
			(await stored(path)) ?? null,
			'---\ntitle: [broken\n---\nTwo litres\n',
		),
	);
	const broken = await observe();
	expect(broken.issues?.[0]?.kind).toBe('frontmatter');
	edit.change(broken, { body: 'Three litres\n' });

	expectOk(
		await folder.files.write(path, (await stored(path)) ?? null, repaired),
	);
	const valid = await observe();
	expect(valid.issues).toBeNull();
	edit.change(valid, { fields: { title: 'Oat milk' } });
	await edit.save();

	expect(edit.pending).toBeUndefined();
	expect(await stored(path)).toBe(
		'---\ntitle: Oat milk\ndone: false\n---\nThree litres\n',
	);
});

test('a body typed over broken frontmatter lands without touching the header', async () => {
	const { folder, edit, observe, stored } = await setup();
	const path = 'notes/milk.md';
	expectOk(
		await folder.files.write(
			path,
			(await stored(path)) ?? null,
			'---\ntitle: [broken\n---\nTwo litres\n',
		),
	);
	edit.change(await observe(), { body: 'Repaired by hand' });
	await edit.save();

	expect(edit.pending).toBeUndefined();
	expect(await stored(path)).toBe('---\ntitle: [broken\n---\nRepaired by hand');
});

// ============================================================================
// Nested changes
// ============================================================================

test('fields and body are typed apart or together, each change one update', async () => {
	const { folder, engine } = await setup();
	expectOk(
		await folder.tables.letters.set('a', null, {
			fields: { title: 'Dear', body: 'a field' },
			body: 'The letter\n',
		}),
	);
	const row = expectOk(await folder.tables.letters.get('a'));
	if (row === undefined) throw new Error('No letter');
	const edit = folder.tables.letters.edit('a');
	const heard: unknown[] = [];
	cleanup.push(edit.subscribe((path) => heard.push(path)));

	expect(edit.change(row, { fields: { title: 'Dearest' } })).toBe(true);
	expect(edit.pending).toMatchObject({
		fields: { title: 'Dearest' },
		body: undefined,
	});
	expect(edit.change(row, { body: 'The whole letter\n' })).toBe(true);
	expect(edit.pending).toMatchObject({
		fields: { title: 'Dearest' },
		body: 'The whole letter\n',
	});
	// A frontmatter field named `body` is a field; the row's body is untouched.
	const before = edit.pending;
	expect(edit.change(row, { fields: { body: 'another field' } })).toBe(true);
	expect(edit.pending).toMatchObject({
		fields: { title: 'Dearest', body: 'another field' },
		body: 'The whole letter\n',
	});
	expect(edit.pending).not.toBe(before);
	expect(heard).toEqual(['letters/a.md', 'letters/a.md', 'letters/a.md']);

	// Fields and body together: one notification, one save.
	heard.length = 0;
	edit.change(row, { fields: { title: 'Dear friend' }, body: 'Hello\n' });
	expect(heard).toEqual(['letters/a.md']);
	const sets = intercept(engine.tables.letters, 'set');
	await edit.save();
	expect(sets.calls).toHaveLength(1);
	const saved = expectOk(await folder.tables.letters.get('a'));
	expect(saved?.fields).toEqual({
		title: 'Dear friend',
		body: 'another field',
	});
	expect(saved?.body).toBe('Hello\n');

	// An empty change takes nothing.
	heard.length = 0;
	expect(edit.change(row, {})).toBe(true);
	expect(edit.pending).toBeUndefined();
	expect(heard).toEqual([]);
});

// ============================================================================
// What a view showed
// ============================================================================

test('a row change from a view that showed older input merges into what is held', async () => {
	const { engine, edit, observe, stored } = await setup('one\ntwo\nthree\n');
	const sets = intercept(engine.tables.notes, 'set');
	const view = edit.shown(await observe());
	edit.change(view.source, { body: 'ONE\ntwo\nthree\n' });
	const started = sets.next();
	sets.hold();
	const first = edit.save();
	await started;
	// The same view's next callback, typed over what that view showed.
	expect(edit.change(view.source, { body: 'one\ntwo\nthree typed\n' })).toBe(
		true,
	);
	sets.release();
	await first;
	await edit.save();

	expect(await stored('notes/milk.md')).toBe(
		'---\ndone: false\ntitle: Milk\n---\nONE\ntwo\nthree typed\n',
	);
	expect(sets.calls).toHaveLength(2);
	type Call = [unknown, { text: string }, { body: string }];
	const [[, firstFrom, firstChange], [, secondFrom, secondChange]] =
		sets.calls as [Call, Call];
	expect(firstFrom.text.endsWith('---\none\ntwo\nthree\n')).toBe(true);
	expect(firstChange.body).toBe('ONE\ntwo\nthree\n');
	expect(secondFrom.text.endsWith('---\nONE\ntwo\nthree\n')).toBe(true);
	expect(secondChange.body).toBe('ONE\ntwo\nthree typed\n');
});

test('a row change from a view that showed the held input replaces it, so a revert saves', async () => {
	const { engine, edit, observe, stored } = await setup('one\ntwo\nthree\n');
	const sets = intercept(engine.tables.notes, 'set');
	const observed = await observe();
	const before = edit.shown(observed);
	edit.change(before.source, { body: 'ONE\ntwo\nthree\n' });
	const started = sets.next();
	sets.hold();
	const first = edit.save();
	await started;
	const after = edit.shown(observed);
	expect(after).not.toBe(before);
	expect(after.row.body).toBe('ONE\ntwo\nthree\n');
	edit.change(after.source, { body: 'one\ntwo\nthree\n' });
	sets.release();
	await first;
	await edit.save();

	expect(await stored('notes/milk.md')).toBe(
		'---\ndone: false\ntitle: Milk\n---\none\ntwo\nthree\n',
	);
	type Call = [unknown, { text: string }, { body: string }];
	const [, [, secondFrom, secondChange]] = sets.calls as [Call, Call];
	expect(secondFrom.text.endsWith('---\nONE\ntwo\nthree\n')).toBe(true);
	expect(secondChange.body).toBe('one\ntwo\nthree\n');
});

test('a text change from a view that showed older text merges; one that showed the held text replaces it', async () => {
	for (const revert of [false, true]) {
		const { folder, engine, observeFile, stored } = await setup();
		const path = 'notes/list.txt';
		expectOk(await folder.files.write(path, null, 'one\ntwo\nthree\n'));
		const writes = intercept(engine.files, 'write');
		const bytes = await observeFile(path);
		const text = folder.files.edit(path);
		const view = text.shown(bytes);
		expect(view.text).toBe('one\ntwo\nthree\n');
		text.change(view.source, 'ONE\ntwo\nthree\n');
		const started = writes.next();
		writes.hold();
		const first = text.save();
		await started;
		if (revert) {
			const shown = text.shown(bytes);
			expect(shown.text).toBe('ONE\ntwo\nthree\n');
			text.change(shown.source, 'one\ntwo\nthree\n');
		} else text.change(view.source, 'one\ntwo\nthree typed\n');
		writes.release();
		await first;
		await text.save();

		expect(await stored(path)).toBe(
			revert ? 'one\ntwo\nthree\n' : 'ONE\ntwo\nthree typed\n',
		);
		expect(writes.calls.map(([, from, content]) => [from, content])).toEqual([
			[new TextEncoder().encode('one\ntwo\nthree\n'), 'ONE\ntwo\nthree\n'],
			[
				'ONE\ntwo\nthree\n',
				revert ? 'one\ntwo\nthree\n' : 'ONE\ntwo\nthree typed\n',
			],
		]);
		await folder.close();
	}
});

test('text typed over plain observed bytes merges with held text those bytes did not show', async () => {
	for (const same of [true, false]) {
		const { folder, observeFile, stored } = await setup();
		const path = 'notes/raw.txt';
		expectOk(await folder.files.write(path, null, 'one\ntwo\n'));
		const seen = await observeFile(path);
		const text = folder.files.edit(path);
		text.change(seen, 'ONE\ntwo\n');
		text.change(same ? seen : seen.slice(), 'one\nTWO\n');
		expect(text.pending).toMatchObject({ text: 'ONE\nTWO\n' });

		// A view that showed the held text replaces it, a revert included.
		const view = text.shown(seen);
		expect(view.text).toBe('ONE\nTWO\n');
		text.change(view.source, 'one\nTWO\n');
		expect(text.pending).toMatchObject({ text: 'one\nTWO\n' });
		// With nothing observed, typing replaces the held text it continues.
		text.change(undefined, 'one\nTWO\nthree\n');
		expect(text.pending).toMatchObject({ text: 'one\nTWO\nthree\n' });
		await text.save();
		expect(await stored(path)).toBe('one\nTWO\nthree\n');
	}
});

test('a save asked for while a save starts joins it, and typing goes on in order', async () => {
	const { folder, engine, observeFile, stored } = await setup();
	const path = 'notes/reentrant.txt';
	expectOk(await folder.files.write(path, null, 'a\n'));
	const text = folder.files.edit(path);
	const writes = intercept(engine.files, 'write');
	writes.hold();
	let asked = 0;
	const stop = text.subscribe(() => {
		if (asked === 0 && text.pending?.saving === true) {
			asked++;
			void text.save();
		}
	});
	cleanup.push(stop);
	text.change(await observeFile(path), 'b\n');
	const saving = text.save();
	expect(asked).toBe(1);
	text.change(undefined, 'c\n');
	writes.release();
	await saving;
	await text.save();
	expect(writes.calls.map(([, , content]) => content)).toEqual(['b\n', 'c\n']);
	expect(await stored(path)).toBe('c\n');
});

test('from close on, save and retry send nothing new and the held input stays', async () => {
	const { folder, engine, observeFile, stored } = await setup();
	const path = 'notes/late.txt';
	expectOk(await folder.files.write(path, null, 'a\n'));
	const text = folder.files.edit(path);
	text.change(await observeFile(path), 'b\n');
	const writes = intercept(engine.files, 'write');
	const restore = fillDisk();
	const closing = folder.close();
	// Asked for while close runs: it joins close.
	const during = text.retry();
	const unsaved = await closing;
	await during;
	expect(unsaved).toMatchObject([{ path, text: 'b\n' }]);
	restore();
	const sent = writes.calls.length;

	await text.save();
	await text.retry();
	expect(writes.calls).toHaveLength(sent);
	expect(text.pending).toMatchObject({
		text: 'b\n',
		error: { name: 'StorageFailed' },
	});
	expect(await stored(path)).toBe('a\n');
});

// ============================================================================
// Own saves a read may not show yet
// ============================================================================

test('a landed save stays shown over the view it was typed in until a read after it, so typing on keeps it', async () => {
	const { folder, engine, edit, observe } = await setup();
	const old = await observe();
	edit.change(edit.shown(old).source, { fields: { title: 'Oat milk' } });
	await edit.save();
	expect(edit.pending).toBeUndefined();
	expect(folder.status.unsaved).toEqual([]);

	// The view never read again.
	const view = edit.shown(old);
	expect(view.row.fields.title).toBe('Oat milk');
	const sets = intercept(engine.tables.notes, 'set');
	edit.change(view.source, { fields: { title: `${view.row.fields.title}!` } });
	await edit.save();

	expect(expectOk(await folder.tables.notes.get('milk'))?.fields.title).toBe(
		'Oat milk!',
	);
	const [[, from]] = sets.calls as [[unknown, { text: string }]];
	expect(from.text).toContain('title: Oat milk\n');
});

test('two views keep the reads they were given: an equal later read relabels no older value', async () => {
	const { edit, observe, elsewhere } = await setup();
	const old = await observe();
	edit.change(old, { fields: { title: 'Mine' } });
	await edit.save();
	expect(edit.shown(old).row.fields.title).toBe('Mine');

	// Another writer puts the original back; a later read sees it.
	await elsewhere({ fields: { title: 'Milk' } });
	const fresh = await observe();
	expect(fresh.text).toBe(old.text);
	expect(fresh).not.toBe(old);
	expect(edit.shown(fresh).row.fields.title).toBe('Milk');
	// The view still holding the older value was never given the later read.
	expect(edit.shown(old).row.fields.title).toBe('Mine');

	// Externally changed after the save, the later read shows the change.
	await elsewhere({ fields: { title: 'Theirs' } });
	expect(edit.shown(await observe()).row.fields.title).toBe('Theirs');
	expect(edit.shown(old).row.fields.title).toBe('Mine');
});

test('a read note is written once, and a derived value carries it without relabeling another', async () => {
	const folder = {};
	const old = {};
	noteRead(old, folder, 0);
	noteRead(old, folder, 1);
	expect(readOf(old, folder)).toBe(0);
	expect(readOf(old, {})).toBe(-1);
	expect(readOf(undefined, folder)).toBe(-1);

	const blob = new Blob(['a']);
	noteRead(blob, folder, 3);
	const bytes = await fileBytes(blob);
	expect(readOf(bytes, folder)).toBe(3);
	expect(readOf(new Uint8Array(await blob.arrayBuffer()), folder)).toBe(-1);
});

test('bytes decoded with fileBytes keep their read; bytes decoded otherwise count as older than own saves', async () => {
	const { folder, other, observeFile } = await setup();
	const path = 'notes/a.txt';
	expectOk(await folder.files.write(path, null, 'one\n'));
	const text = folder.files.edit(path);
	text.change(await observeFile(path), 'mine\n');
	await text.save();
	expectOk(await other.files.write(path, 'mine\n', 'theirs\n'));

	const file = expectOk(await folder.files.read(path));
	if (file === undefined) throw new Error('No file');
	expect(text.shown(await fileBytes(file.content)).text).toBe('theirs\n');
	expect(
		text.shown(new Uint8Array(await file.content.arrayBuffer())).text,
	).toBe('mine\n');
});

test('whole text typed over an older view composes with an own field save it never showed', async () => {
	const { folder, engine, edit, observe, observeFile, stored } = await setup();
	const path = 'notes/milk.md';
	const rowA = await observe();
	const bytesA = await observeFile(path);
	const textA = decode(bytesA);
	edit.change(rowA, { fields: { title: 'Mine' } });
	await edit.save();

	const text = folder.files.edit(path);
	const writes = intercept(engine.files, 'write');
	text.change(bytesA, `${textA}append\n`);
	await text.save();
	const first = '---\ndone: false\ntitle: Mine\n---\nTwo litres\nappend\n';
	expect(await stored(path)).toBe(first);
	expect(writes.calls[0]?.[1]).toEqual(bytesA);
	expect(text.shown(bytesA).text).toBe(first);
	expect(edit.shown(rowA).row).toMatchObject({
		fields: { title: 'Mine', done: false },
		body: 'Two litres\nappend\n',
	});

	// A second whole text from the same old view keeps both earlier saves.
	text.change(bytesA, `${textA}second\n`);
	await text.save();
	const second =
		'---\ndone: false\ntitle: Mine\n---\nTwo litres\nappend\nsecond\n';
	expect(await stored(path)).toBe(second);
	expect(writes.calls[1]?.[1]).toEqual(bytesA);
	expect(text.shown(bytesA).text).toBe(second);
	expect(edit.shown(rowA).row.body).toBe('Two litres\nappend\nsecond\n');

	// Typed over a view that showed the own field, reverting it saves.
	const view = text.shown(bytesA);
	text.change(view.source, second.replace('title: Mine', 'title: Before'));
	await text.save();
	expect(writes.calls[2]?.[1]).toEqual(new TextEncoder().encode(second));
	expect(await stored(path)).toBe(
		second.replace('title: Mine', 'title: Before'),
	);
	expect(edit.shown(rowA).row.fields.title).toBe('Before');
	expect(text.shown(bytesA).text).toBe(
		second.replace('title: Mine', 'title: Before'),
	);
});

test('whole text typed over a fresh read that superseded an own field save does not bring that save back', async () => {
	const { folder, other, edit, observe, observeFile, stored } = await setup();
	const path = 'notes/milk.md';
	const oldRow = await observe();
	const oldBytes = await observeFile(path);
	edit.change(oldRow, { fields: { title: 'Mine' } });
	await edit.save();
	// Another writer replaces the title; this folder reads the file again.
	const current = expectOk(await other.tables.notes.get('milk'));
	expectOk(
		await other.tables.notes.set('milk', current ?? null, {
			fields: { title: 'Outside' },
		}),
	);
	const fresh = await observeFile(path);
	const outside = '---\ndone: false\ntitle: Outside\n---\nTwo litres\n';
	expect(decode(fresh)).toBe(outside);

	const text = folder.files.edit(path);
	const view = text.shown(fresh);
	expect(view.text).toBe(outside);
	text.change(view.source, `${view.text}append\n`);
	await text.save();
	const first = `${outside}append\n`;
	expect(await stored(path)).toBe(first);
	expect(text.shown(fresh).text).toBe(first);
	// The whole text supersedes the older own save for every older view too.
	expect(text.shown(oldBytes).text).toBe(first);
	expect(edit.shown(oldRow).row.fields.title).toBe('Outside');

	const next = text.shown(fresh);
	text.change(next.source, `${next.text}second\n`);
	await text.save();
	const second = `${first}second\n`;
	expect(await stored(path)).toBe(second);
	expect(text.shown(fresh).text).toBe(second);
	expect(text.shown(oldBytes).text).toBe(second);
});

test('a body typed over a fresh read that superseded an own body save does not bring that body back', async () => {
	const { edit, observe, elsewhere, stored } = await setup();
	const oldRow = await observe();
	edit.change(oldRow, { body: 'Mine\n' });
	await edit.save();
	await elsewhere({ body: 'Outside\n' });
	const fresh = await observe();
	expect(fresh.body).toBe('Outside\n');

	const view = edit.shown(fresh);
	edit.change(view.source, { body: `${view.row.body}append\n` });
	await edit.save();
	const disk = '---\ndone: false\ntitle: Milk\n---\nOutside\nappend\n';
	expect(await stored('notes/milk.md')).toBe(disk);
	expect(edit.shown(fresh).row.body).toBe('Outside\nappend\n');
	expect(edit.shown(oldRow).row.body).toBe('Outside\nappend\n');

	const next = edit.shown(fresh);
	edit.change(next.source, { body: `${next.row.body}second\n` });
	await edit.save();
	expect(await stored('notes/milk.md')).toBe(
		'---\ndone: false\ntitle: Milk\n---\nOutside\nappend\nsecond\n',
	);
	expect(edit.shown(oldRow).row.body).toBe('Outside\nappend\nsecond\n');
});

test('a body keeps the age of the source it was typed over when a field is typed over a fresher one', async () => {
	const { folder, edit, observe, observeFile, stored } = await setup();
	const path = 'notes/milk.md';
	const oldRow = await observe();
	const text = folder.files.edit(path);
	text.change(await observeFile(path), `${oldRow.text}#mine\n`);
	await text.save();
	expect(edit.shown(oldRow).row.body).toBe('Two litres\n#mine\n');

	// The body is typed over the old view; a field over a fresh one.
	edit.change(oldRow, { body: 'Two litres\nappend\n' });
	edit.change(await observe(), { fields: { title: 'Oat milk' } });
	await edit.save();
	expect(await stored(path)).toBe(
		'---\ndone: false\ntitle: Oat milk\n---\nTwo litres\n#mine\nappend\n',
	);
	expect(edit.shown(oldRow).row).toMatchObject({
		fields: { title: 'Oat milk' },
		body: 'Two litres\n#mine\nappend\n',
	});
});

test('an own whole-text save stays over an old view beside a later field save, without a body that view never read', async () => {
	const { folder, other, observeFile, stored } = await setup();
	const path = 'docs/a.md';
	expectOk(
		await folder.files.write(path, null, '---\ntitle: original\n---\nbodyA\n'),
	);
	const oldA = await observeFile(path);
	const text = folder.files.edit(path);
	text.change(oldA, '---\ntitle: original\n---\n#mine\nbodyA\n');
	await text.save();
	expectOk(
		await other.files.write(
			path,
			'---\ntitle: original\n---\n#mine\nbodyA\n',
			'---\ntitle: original\n---\n#mine\nbodyB\n',
		),
	);
	expect(text.changeFields(oldA, { title: 'T2' })).toBe(true);
	await text.save();
	expect(await stored(path)).toBe('---\ntitle: T2\n---\n#mine\nbodyB\n');
	expect(text.shown(oldA).text).toBe('---\ntitle: T2\n---\n#mine\nbodyA\n');

	const view = text.shown(oldA);
	text.change(view.source, `${view.text}more\n`);
	await text.save();
	expect(await stored(path)).toBe('---\ntitle: T2\n---\n#mine\nbodyB\nmore\n');
	expect(text.shown(oldA).text).toBe(
		'---\ntitle: T2\n---\n#mine\nbodyA\nmore\n',
	);
});

test('with nothing observed, own saved text and held text stay readable but are no source to type over', async () => {
	const { folder, observeFile } = await setup();
	const path = 'notes/u.txt';
	expectOk(await folder.files.write(path, null, 'old\n'));
	const text = folder.files.edit(path);
	text.change(await observeFile(path), 'mine\n');
	await text.save();

	expect(text.shown(undefined)).toEqual({ source: undefined, text: 'mine\n' });
	expect(text.change(undefined, 'more\n')).toBe(false);
	expect(text.pending).toBeUndefined();

	// Held input that did not save stays readable and typable over itself.
	const restore = fillDisk();
	text.change(await observeFile(path), 'held\n');
	await text.save();
	restore();
	expect(text.pending?.error?.name).toBe('StorageFailed');
	expect(text.shown(undefined)).toEqual({ source: undefined, text: 'held\n' });
	expect(text.change(undefined, 'held, more\n')).toBe(true);
	expect(text.pending?.kind === 'text' && text.pending.text).toBe(
		'held, more\n',
	);
});

test('a delete that keeps a file changed meanwhile keeps own saves shown; one that removes it forgets them', async () => {
	const { engine, edit, observe, elsewhere } = await setup();
	const old = await observe();
	edit.change(old, { fields: { title: 'Mine' } });
	await edit.save();

	const deletes = intercept(engine.tables.notes, 'delete');
	const started = deletes.next();
	deletes.hold();
	const deleting = edit.delete();
	await started;
	await elsewhere({ body: 'Changed meanwhile\n' });
	deletes.release();
	expect(expectOk(await deleting)).toEqual({ deleted: false });
	expect(edit.shown(old).row.fields.title).toBe('Mine');

	deletes.restore();
	expect(expectOk(await edit.delete())).toEqual({ deleted: true });
	expect(edit.shown(old).row.fields.title).toBe('Milk');
});

test('two own saves of one path started before either lands run one at a time, each its own commit', async () => {
	const { folder, engine, other, edit, observe, stored } = await setup();
	const path = 'notes/milk.md';
	// The first save (the edit's) is held before and after its commit; the
	// second (a direct one) before its commit.
	const set = engine.tables.notes.set;
	const gates = {
		firstCommit: Promise.withResolvers<void>(),
		firstReturn: Promise.withResolvers<void>(),
		second: Promise.withResolvers<void>(),
	};
	const reached = {
		first: Promise.withResolvers<void>(),
		committed: Promise.withResolvers<void>(),
		second: Promise.withResolvers<void>(),
	};
	let calls = 0;
	engine.tables.notes.set = async (...args) => {
		if (calls++ === 0) {
			reached.first.resolve();
			await gates.firstCommit.promise;
			const result = await set(...args);
			reached.committed.resolve();
			await gates.firstReturn.promise;
			return result;
		}
		reached.second.resolve();
		await gates.second.promise;
		return set(...args);
	};
	cleanup.push(() => {
		for (const gate of Object.values(gates)) gate.resolve();
	});
	const old = await observe();
	edit.change(old, { fields: { title: 'Mine' } });
	const first = edit.save();
	const second = folder.tables.notes.set('milk', old, {
		fields: { done: true },
	});
	await reached.first.promise;

	gates.firstCommit.resolve();
	await reached.committed.promise;
	// Another writer replaces the title; this folder reads that.
	const current = expectOk(await other.tables.notes.get('milk'));
	expectOk(
		await other.tables.notes.set('milk', current ?? null, {
			fields: { title: 'Outside' },
		}),
	);
	const fresh = await observe();
	expect(fresh.fields.title).toBe('Outside');

	// The direct save waits for the first, and starts only once it returned.
	await Bun.sleep(5);
	expect(calls).toBe(1);
	gates.firstReturn.resolve();
	await first;
	await reached.second.promise;
	gates.second.resolve();
	expectOk(await second);

	expect(await stored(path)).toContain('title: Outside');
	expect(await stored(path)).toContain('done: true');
	// The fresh read began after the first save landed, so it shows it.
	expect(edit.shown(fresh).row.fields.title).toBe('Outside');
	expect(edit.shown(await observe()).row.fields.title).toBe('Outside');
	expect(edit.shown(old).row.fields.title).toBe('Mine');
});

test.each(['another path', 'the same path'] as const)(
	'a save held after it landed is the commit it landed as, whatever own save of %s follows it',
	async (between) => {
		const { folder, engine, other, edit, observe, stored } = await setup();
		const path = 'notes/milk.md';
		// Hold the save after storage committed it and reported the change.
		const set = engine.tables.notes.set;
		const committed = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		engine.tables.notes.set = async (...args) => {
			const result = await set(...args);
			if (args[0] === 'milk') {
				committed.resolve();
				await gate.promise;
			}
			return result;
		};
		cleanup.push(() => gate.resolve());
		edit.change(await observe(), { fields: { title: 'Mine' } });
		const saving = edit.save();
		await committed.promise;

		// Another writer replaces it; this folder reads that, then saves again.
		const current = expectOk(await other.tables.notes.get('milk'));
		expectOk(
			await other.tables.notes.set('milk', current ?? null, {
				fields: { title: 'Outside' },
			}),
		);
		const fresh = await observe();
		expect(fresh.fields.title).toBe('Outside');
		// An own save after that read: of another path it lands before the
		// held save resolves; of the same path it waits for it.
		if (between === 'another path') {
			expectOk(await folder.files.write('notes/other.txt', null, 'other'));
			gate.resolve();
		} else {
			const file = expectOk(await folder.files.read(path));
			const writing = folder.files.write(
				path,
				await fileBytes(file!.content),
				`${fresh.text}more\n`,
			);
			gate.resolve();
			expectOk(await writing);
		}
		await saving;

		expect(await stored(path)).toContain('title: Outside');
		// The fresh read began after the held save landed, so it shows it.
		expect(edit.shown(fresh).row.fields.title).toBe('Outside');
		expect(edit.shown(await observe()).row.fields.title).toBe('Outside');
	},
);

test('a direct row save takes its change as it was at the call, queued or not', async () => {
	for (const queued of [false, true]) {
		const { folder, engine, observe } = await setup();
		const sets = intercept(engine.tables.notes, 'set');
		let first: Promise<unknown> | undefined;
		if (queued) {
			const started = sets.next();
			sets.hold();
			first = folder.tables.notes.set('milk', await observe(), {
				fields: { done: true },
			});
			await started;
		}
		const row = await observe();
		// Proxied, as a UI's deep state is: structured cloning cannot copy it.
		const fields = new Proxy(
			{ title: 'accepted', tags: new Proxy(['kept'], {}) },
			{},
		);
		const saving = folder.tables.notes.set('milk', row, {
			fields: fields as unknown as { title: string },
		});
		fields.title = 'changed after the call';
		fields.tags.push('changed after the call');
		sets.release();
		await first;
		expectOk(await saving);
		const stored = expectOk(await folder.tables.notes.get('milk'));
		expect(stored?.fields).toMatchObject({ title: 'accepted', tags: ['kept'] });
		await folder.close();
	}
});

test('a queued row save refuses fields the folder cannot write at the call, as an unqueued one does', async () => {
	for (const queued of [false, true]) {
		const { folder, engine, observe } = await setup();
		const sets = intercept(engine.tables.notes, 'set');
		let first: Promise<unknown> | undefined;
		if (queued) {
			const started = sets.next();
			sets.hold();
			first = folder.tables.notes.set('milk', await observe(), {
				fields: { done: true },
			});
			await started;
		}
		const refused = await folder.tables.notes.set('milk', await observe(), {
			fields: { title: (() => 'a function') as unknown as string },
		});
		expect(expectErr(refused).name).toBe('Unparseable');
		sets.release();
		await first;
		await folder.close();
	}
});

test('settle waits for direct saves already started, not for reads', async () => {
	const { folder, engine } = await setup();
	const writes = intercept(engine.files, 'write');
	const started = writes.next();
	writes.hold();
	const writing = folder.files.write('notes/direct.txt', null, 'direct');
	await started;
	engine.files.read = () => new Promise(() => {});
	void folder.files.read('notes/direct.txt');
	let settled = false;
	const settling = folder.settle().then(() => {
		settled = true;
	});
	await Bun.sleep(5);
	expect(settled).toBe(false);
	writes.release();
	expectOk(await writing);
	await settling;
	expect(settled).toBe(true);
});

test('a pause that is not a finite number of milliseconds from zero up is refused before opening', async () => {
	globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
	for (const saveAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY])
		await expect(openFolder({ tables, saveAfterMs })).rejects.toThrow(
			RangeError,
		);
	const folder = expectOk(await openFolder({ tables, saveAfterMs: 0 }));
	await folder.close();
});

test('a save whose content was already stored is reported as a change of its path', async () => {
	const { folder, edit, observe } = await setup();
	const heard: FolderChange[] = [];
	cleanup.push(folder.onChange((change) => heard.push(change)));
	edit.change(await observe(), { fields: { title: 'Milk' } });
	await edit.save();
	expect(heard).toEqual([{ paths: ['notes/milk.md'], origin: 'this-handle' }]);

	edit.change(await observe(), { fields: { title: 'Oat milk' } });
	await edit.save();
	expect(heard).toHaveLength(2);
});

// ============================================================================
// Handles
// ============================================================================

test('handles are passive and share one input whose identity holds until it changes', async () => {
	const { folder, observe } = await setup();
	const heard: (string | undefined)[] = [];
	const first = folder.tables.notes.edit('milk');
	const stop = first.subscribe((path) => heard.push(path));
	const second = folder.tables.notes.edit('milk');
	expect(second.subscribe).toBe(first.subscribe);
	expect(first.pending).toBeUndefined();
	expect(heard).toEqual([]);

	const row = await observe();
	expect(first.shown(row)).toBe(first.shown(row));
	first.change(row, { fields: { title: 'Oat milk' } });
	const pending = second.pending;
	expect(pending).toBe(first.pending);
	expect(pending).toMatchObject({
		path: 'notes/milk.md',
		fields: { title: 'Oat milk' },
		body: undefined,
		saving: false,
	});
	expect(Object.keys(pending ?? {})).not.toContain('bases');
	expect(heard).toEqual(['notes/milk.md']);

	stop();
	second.discard();
	expect(heard).toEqual(['notes/milk.md']);
	expect(first.pending).toBeUndefined();
});

test('text saves exactly what was typed and newer typing keeps its source', async () => {
	const { folder, observeFile, stored } = await setup();
	const path = 'notes/a.txt';
	const original = '﻿one\r\ntwo\r\n';
	expectOk(await folder.files.write(path, null, original));
	const bytes = await observeFile(path);
	const edit = folder.files.edit(path);
	edit.change(bytes, '﻿one!\r\ntwo\r\n');
	bytes.fill(0);
	edit.change(undefined, '﻿one!\r\ntwo?\r\n');
	await edit.save();

	expect(edit.pending).toBeUndefined();
	const saved = expectOk(await folder.files.read(path));
	expect(await fileBytes(saved!.content)).toEqual(
		new TextEncoder().encode('﻿one!\r\ntwo?\r\n'),
	);
	expect(await stored(path)).toBe('one!\r\ntwo?\r\n');
});

test('row and text input exclude each other on one path', async () => {
	const { folder, edit, observe, observeFile } = await setup();
	const text = folder.files.edit('notes/milk.md');
	const row = await observe();
	const bytes = await observeFile('notes/milk.md');
	expect(text.change(bytes, 'typed source')).toBe(true);
	expect(edit.change(row, { body: 'typed body' })).toBe(false);
	expect(text.discard()).toMatchObject({ kind: 'text', text: 'typed source' });
	expect(edit.change(row, { body: 'typed body' })).toBe(true);
	expect(text.change(bytes, 'typed source')).toBe(false);
	expect(text.changeFields(bytes, { title: 'x' })).toBe(false);
});

// ============================================================================
// Failure, delete and close
// ============================================================================

test('a failed save keeps its input and error for copying or discard', async () => {
	const { folder, edit, observe } = await setup();
	const restore = fillDisk();
	edit.change(await observe(), { fields: { title: 'Oat milk' } });
	await edit.save();

	expect(edit.pending?.error?.name).toBe('StorageFailed');
	expect(folder.status.failures).toMatchObject([
		{ path: 'notes/milk.md', fields: { title: 'Oat milk' } },
	]);
	expect(folder.status.storageFailure?.name).toBe('StorageFailed');
	expect(expectErr(await edit.delete()).name).toBe('NotStarted');
	restore();
	expect(edit.discard()).toMatchObject({ fields: { title: 'Oat milk' } });
	expect(folder.status.unsaved).toEqual([]);
	expect(folder.status.failures).toEqual([]);
});

test('a thrown storage call is a StorageFailed save that keeps its input to save again', async () => {
	const { folder, engine, edit, observe } = await setup();
	const set = engine.tables.notes.set;
	engine.tables.notes.set = async () => {
		throw new Error('transport disconnected');
	};
	edit.change(await observe(), { fields: { title: 'Oat milk' } });
	await edit.save();
	expect(edit.pending?.error?.name).toBe('StorageFailed');

	engine.tables.notes.set = set;
	await edit.retry();
	expect(edit.pending).toBeUndefined();
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields.title).toBe(
		'Oat milk',
	);
});

test('a save asked for during a delete sends held input once and cannot restore the row', async () => {
	const { folder, engine, edit, observe } = await setup();
	edit.change(await observe(), { fields: { title: 'Oat milk' } });
	const sets = intercept(engine.tables.notes, 'set');
	const started = sets.next();
	sets.hold();
	const deleting = edit.delete();
	// As a view does when the person leaves the field, or the view goes away.
	const saving = edit.save();
	await started;
	sets.release();
	expect(expectOk(await deleting)).toEqual({ deleted: true });
	await saving;

	expect(sets.calls).toHaveLength(1);
	expect(edit.pending).toBeUndefined();
	expect(expectOk(await folder.tables.notes.get('milk'))).toBeUndefined();
});

test('a file delete keeps a file another writer changed after the delete read it', async () => {
	const { folder, engine, other, stored } = await setup();
	const path = 'notes/a.txt';
	expectOk(await folder.files.write(path, null, 'one'));
	const deletes = intercept(engine.files, 'delete');
	const started = deletes.next();
	deletes.hold();
	const deleting = folder.files.edit(path).delete();
	await started;
	expectOk(await other.files.write(path, 'one', 'another writer'));
	deletes.release();

	expect(expectOk(await deleting)).toEqual({ deleted: false });
	expect(await stored(path)).toBe('another writer');
});

test('delete fences input at once and removes the row after its held save', async () => {
	const { folder, edit, observe } = await setup();
	const row = await observe();
	edit.change(row, { fields: { title: 'Oat milk' } });
	const deleting = edit.delete();
	expect(edit.locked).toBe(true);
	expect(edit.change(row, { fields: { title: 'Later' } })).toBe(false);
	expect(folder.status.saving).toBe(true);

	expect(expectOk(await deleting)).toEqual({ deleted: true });
	expect(edit.pending).toBeUndefined();
	expect(folder.status.saving).toBe(false);
	expect(expectOk(await folder.tables.notes.get('milk'))).toBeUndefined();
});

test('close with no view sends a running save, answers a failed one, and fences input', async () => {
	const { folder, observe, observeFile } = await setup();
	const bread = 'notes/bread.md';
	expectOk(await folder.files.write(bread, null, 'Rye'));
	const text = folder.files.edit(bread);
	text.change(await observeFile(bread), 'Sourdough');
	const milk = folder.tables.notes.edit('milk');
	milk.change(await observe(), { body: 'Oat, two litres' });
	const restore = fillDisk();
	const running = milk.save();
	expect(milk.pending?.saving).toBe(true);

	const closing = folder.close();
	expect(folder.status.closing).toBe(true);
	expect(text.change(undefined, 'Too late')).toBe(false);
	await running;
	const unsaved = await closing;
	restore();

	expect(unsaved).toMatchObject([
		{ path: bread, text: 'Sourdough' },
		{ path: 'notes/milk.md', body: 'Oat, two litres' },
	]);
	expect(
		unsaved.every((pending) => pending.error?.name === 'StorageFailed'),
	).toBe(true);
	expect(folder.close()).toBe(closing);
	// What did not save stays readable after the engine is released.
	expect(folder.status.failures).toEqual(unsaved);
	expect(text.pending).toBe(unsaved[0] as never);
	expect(milk.pending).toBe(unsaved[1] as never);
});

test('a status listener cannot reach storage once close is called, while held input lands and the engine closes once', async () => {
	const { folder, engine, edit, observe } = await setup();
	const writes = intercept(engine.files, 'write');
	let closes = 0;
	const close = engine.close;
	engine.close = () => {
		closes++;
		close();
	};
	const refused: unknown[] = [];
	folder.onStatusChange((status) => {
		if (!status.saving) return;
		try {
			void folder.files.write('reentrant.md', null, 'late');
		} catch (cause) {
			refused.push(cause);
		}
	});
	edit.change(await observe(), { fields: { title: 'Oat milk' } });

	await folder.close();

	expect(refused.length).toBeGreaterThan(0);
	expect(refused).toEqual(
		refused.map(() =>
			expect.objectContaining({ message: 'The folder is closed' }),
		),
	);
	expect(writes.calls.map(([path]) => path)).not.toContain('reentrant.md');
	expect(closes).toBe(1);
	const reopened = await open();
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields.title).toBe(
		'Oat milk',
	);
	expect(expectOk(await reopened.files.read('reentrant.md'))).toBeUndefined();
});

test('an edit listener at the close fence is refused storage, closes to the same promise, and the engine closes once', async () => {
	const { folder, engine, edit, observe } = await setup();
	const row = await observe();
	edit.change(row, { fields: { title: 'Oat milk' } });
	const writes = intercept(engine.files, 'write');
	let closes = 0;
	const close = engine.close;
	engine.close = () => {
		closes++;
		close();
	};
	const refused: unknown[] = [];
	let taken: boolean | undefined;
	let inner: Promise<unknown> | undefined;
	const statuses: boolean[] = [];
	cleanup.push(
		edit.subscribe((path) => {
			if (path !== undefined || inner !== undefined) return;
			try {
				void folder.files.write('fence-reentrant.md', null, 'late');
			} catch (cause) {
				refused.push(cause);
			}
			taken = edit.change(row, { fields: { title: 'Too late' } });
			inner = folder.close();
			statuses.push(folder.status.closing);
		}),
	);

	const outer = folder.close();
	expect(inner).toBe(outer);
	expect(refused).toMatchObject([{ message: 'The folder is closed' }]);
	expect(taken).toBe(false);
	await outer;

	expect(writes.calls.map(([path]) => path)).not.toContain(
		'fence-reentrant.md',
	);
	expect(closes).toBe(1);
	const reopened = await open();
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields.title).toBe(
		'Oat milk',
	);
	expect(
		expectOk(await reopened.files.read('fence-reentrant.md')),
	).toBeUndefined();
});

test('closing the folder while a delete runs refuses new calls and lets the delete finish', async () => {
	const { folder, engine, edit } = await setup();
	const gets = intercept(engine.tables.notes, 'get');
	const started = gets.next();
	gets.hold();
	const deleting = edit.delete();
	await started;

	const closing = folder.close();
	expect(() => folder.files.list()).toThrow('closed');
	gets.release();
	expect(expectOk(await deleting)).toEqual({ deleted: true });
	expect(await closing).toEqual([]);

	const reopened = await open();
	expect(expectOk(await reopened.tables.notes.get('milk'))).toBeUndefined();
});

test('close waits for saves, never for a read that does not answer', async () => {
	const { folder, engine, edit, observe } = await setup();
	edit.change(await observe(), { fields: { title: 'Oat' } });
	await edit.save();
	engine.tables.notes.list = () => new Promise(() => {});
	void folder.tables.notes.list();
	edit.change(await observe(), { fields: { title: 'Oat milk' } });

	expect(await folder.close()).toEqual([]);
	const reopened = await open();
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields.title).toBe(
		'Oat milk',
	);
});

// ============================================================================
// The folder owns its input from construction
// ============================================================================

test('plain code opens, edits with no view or subscriber, sees status, settles and closes', async () => {
	for (const openWith of [openFolder, openAutomatic]) {
		globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
		const folder = expectOk(await openWith({ tables, saveAfterMs: 5 }));
		expectOk(
			await folder.tables.notes.set('milk', null, {
				fields: { title: 'Milk', done: false },
				body: '',
			}),
		);
		const statuses: FolderStatus[] = [];
		folder.onStatusChange((status) => statuses.push(status));
		const row = expectOk(await folder.tables.notes.get('milk'));
		if (row === undefined) throw new Error('No row');

		const edit = folder.tables.notes.edit('milk');
		expect(edit.change(row, { fields: { title: 'Oat' } })).toBe(true);
		expect(folder.status.unsaved).toEqual(['notes/milk.md']);
		expect(statuses.at(-1)?.unsaved).toEqual(['notes/milk.md']);
		// The pause the folder was opened with saves it.
		await until(() => folder.status.unsaved.length === 0);
		expect(expectOk(await folder.tables.notes.get('milk'))?.fields.title).toBe(
			'Oat',
		);

		edit.change(row, { fields: { title: 'Oat milk' } });
		expect(await folder.settle()).toEqual([]);
		expect(folder.status).toMatchObject({
			saving: false,
			unsaved: [],
			failures: [],
			closing: false,
		});
		expect(await folder.close()).toEqual([]);
		expect(statuses.at(-1)?.closing).toBe(true);
	}
});

test('accepting and discarding input notify status with no storage call', async () => {
	const { folder, engine, edit, observe } = await setup();
	const sets = intercept(engine.tables.notes, 'set');
	const unsaved: (readonly string[])[] = [];
	folder.onStatusChange((status) => unsaved.push(status.unsaved));
	edit.change(await observe(), { fields: { title: 'Oat' } });
	edit.discard();
	expect(unsaved).toEqual([['notes/milk.md'], []]);
	expect(sets.calls).toEqual([]);
});

// ============================================================================
// One retry contract for every input kind
// ============================================================================

for (const kind of ['row', 'text', 'fields'] as const) {
	test(`${kind}: incidental saves retain failure, retry sends once, and close returns failure`, async () => {
		const { folder, engine, edit, observe, observeFile, stored } =
			await setup();
		const path = 'notes/milk.md';
		const row = await observe();
		const bytes = await observeFile(path);
		const text = folder.files.edit(path);
		const input = kind === 'row' ? edit : text;
		const change = (title: string) => {
			if (kind === 'row') return edit.change(row, { fields: { title } });
			if (kind === 'text')
				return text.change(bytes, decode(bytes).replace('Milk', title));
			return text.changeFields(bytes, { title });
		};
		const rows = intercept(engine.tables.notes, 'set');
		const files = intercept(engine.files, 'write');
		const reads = intercept(engine.files, 'read');
		const submitted = () => rows.calls.length + files.calls.length;
		const restore = fillDisk();
		expect(change('Failed')).toBe(true);
		await input.save();
		expect(input.pending?.error?.name).toBe('StorageFailed');
		expect(submitted()).toBe(1);
		restore();
		const readCount = reads.calls.length;
		const failed = input.pending;
		if (failed === undefined)
			throw new Error('The failed input must remain held');

		await input.save();
		expect(await folder.settle()).toEqual([failed]);
		expect(expectErr(await input.delete())).toMatchObject({
			name: 'NotStarted',
			reason: UNSAVED,
		});
		if (kind !== 'row') {
			let entered = false;
			expect(
				expectErr(
					await text.exclusive(async () => {
						entered = true;
					}),
				),
			).toMatchObject({ name: 'NotStarted', reason: UNSAVED });
			expect(entered).toBe(false);
		}
		expect(submitted()).toBe(1);
		expect(reads.calls).toHaveLength(readCount);

		await input.retry();
		expect(submitted()).toBe(2);
		expect(input.pending).toBeUndefined();
		expect(await stored(path)).toContain('Failed');

		const restoreAgain = fillDisk();
		expect(change('Held for recovery')).toBe(true);
		await input.save();
		restoreAgain();
		expect(submitted()).toBe(3);
		const pending = input.pending;
		if (pending === undefined)
			throw new Error('The failed input must remain held');
		expect(await folder.close()).toEqual([pending]);
		expect(submitted()).toBe(3);
		expect(input.pending).toBe(pending);
	});

	test(`${kind}: new input clears failure and resumes autosave`, async () => {
		const { folder, edit, observe, observeFile, stored } = await setup(
			'Two litres\n',
			5,
		);
		const path = 'notes/milk.md';
		const row = await observe();
		const bytes = await observeFile(path);
		const text = folder.files.edit(path);
		const input = kind === 'row' ? edit : text;
		const change = (title: string) => {
			if (kind === 'row') return edit.change(row, { fields: { title } });
			if (kind === 'text')
				return text.change(bytes, decode(bytes).replace('Milk', title));
			return text.changeFields(bytes, { title });
		};
		const restore = fillDisk();
		expect(change('Failed')).toBe(true);
		await input.save();
		expect(input.pending?.error?.name).toBe('StorageFailed');
		restore();
		expect(change('New input')).toBe(true);
		expect(input.pending?.error).toBeUndefined();
		await until(() => input.pending === undefined);
		expect(await stored(path)).toContain('New input');
	});

	test(`${kind}: retry during failure publication joins the finishing attempt`, async () => {
		const { folder, engine, edit, observe, observeFile } = await setup();
		const path = 'notes/milk.md';
		const row = await observe();
		const bytes = await observeFile(path);
		const text = folder.files.edit(path);
		const input = kind === 'row' ? edit : text;
		const rows = intercept(engine.tables.notes, 'set');
		const files = intercept(engine.files, 'write');
		const restore = fillDisk();
		if (kind === 'row') edit.change(row, { fields: { title: 'Failed' } });
		else if (kind === 'text') text.change(bytes, 'Failed');
		else text.changeFields(bytes, { title: 'Failed' });
		let asked = false;
		let joined: Promise<void> | undefined;
		const whileRunning = Promise.withResolvers<boolean>();
		const stop = input.subscribe(() => {
			if (asked || input.pending?.error === undefined) return;
			asked = true;
			let finished = false;
			joined = input.retry().then(() => {
				finished = true;
			});
			queueMicrotask(() => whileRunning.resolve(finished));
		});
		cleanup.push(stop);
		await input.save();
		expect(await whileRunning.promise).toBe(false);
		await joined;
		restore();
		expect(rows.calls.length + files.calls.length).toBe(1);
		expect(input.pending?.error?.name).toBe('StorageFailed');
	});
}

test('fields typed into failed whole text authorize the newer input', async () => {
	const { folder, observeFile, stored } = await setup('Two litres\n', 5);
	const path = 'notes/milk.md';
	const text = folder.files.edit(path);
	const bytes = await observeFile(path);
	const restore = fillDisk();
	text.change(bytes, decode(bytes).replace('Milk', 'Failed'));
	await text.save();
	restore();
	expect(text.pending?.error?.name).toBe('StorageFailed');
	expect(text.changeFields(bytes, { title: 'New field' })).toBe(true);
	expect(text.pending?.error).toBeUndefined();
	await until(() => text.pending === undefined);
	expect(await stored(path)).toContain('New field');
});

test('a refused row waits for explicit retry after another writer repairs its source', async () => {
	const { folder, other, edit, observe, observeFile, stored } = await setup();
	const path = 'notes/milk.md';
	edit.change(await observe(), { fields: { title: 'Held' } });
	const bytes = await observeFile(path);
	const broken = '---\ntitle: [broken\n---\nbody\n';
	expectOk(await other.files.write(path, bytes, broken));
	await edit.save();
	expect(edit.pending?.error?.name).toBe('Unparseable');
	const fixed = '---\ntitle: Repaired\ndone: false\n---\nbody\n';
	expectOk(await other.files.write(path, broken, fixed));
	await edit.save();
	await folder.settle();
	expect(await stored(path)).toBe(fixed);
	await edit.retry();
	expect(edit.pending).toBeUndefined();
	expect(await stored(path)).toContain('Held');
});

for (const action of ['save', 'discard', 'close'] as const) {
	test(`retry respects a listener that calls ${action} when the failure clears`, async () => {
		const { folder, engine, edit, observe, stored } = await setup();
		const sets = intercept(engine.tables.notes, 'set');
		const restore = fillDisk();
		edit.change(await observe(), { fields: { title: 'Retried' } });
		await edit.save();
		restore();
		let acted = false;
		let work: Promise<unknown> | undefined;
		const stop = edit.subscribe(() => {
			if (
				acted ||
				edit.pending?.error !== undefined ||
				edit.pending === undefined
			)
				return;
			acted = true;
			if (action === 'discard') edit.discard();
			else if (action === 'close') work = folder.close();
			else work = edit.save();
		});
		cleanup.push(stop);
		await edit.retry();
		await work;
		expect(acted).toBe(true);
		expect(sets.calls).toHaveLength(action === 'discard' ? 1 : 2);
		expect(edit.pending).toBeUndefined();
		expect(await stored('notes/milk.md')).toContain(
			action === 'discard' ? 'Milk' : 'Retried',
		);
	});
}

for (const kind of ['row', 'text', 'fields'] as const) {
	for (const request of ['save', 'close'] as const) {
		test(`${kind}: new input requested during failure publication is not stranded by ${request}`, async () => {
			const { folder, engine, edit, observe, observeFile, stored } =
				await setup();
			const path = 'notes/milk.md';
			const row = await observe();
			const bytes = await observeFile(path);
			const text = folder.files.edit(path);
			const input = kind === 'row' ? edit : text;
			const change = (title: string) => {
				if (kind === 'row') return edit.change(row, { fields: { title } });
				if (kind === 'text')
					return text.change(bytes, decode(bytes).replace('Milk', title));
				return text.changeFields(bytes, { title });
			};
			const rows = intercept(engine.tables.notes, 'set');
			const files = intercept(engine.files, 'write');
			const restore = fillDisk();
			let changed = false;
			let joined: Promise<unknown> | undefined;
			const stop = input.subscribe(() => {
				if (changed || input.pending?.error === undefined) return;
				changed = true;
				restore();
				expect(change('New input')).toBe(true);
				joined = request === 'close' ? folder.close() : input.save();
			});
			cleanup.push(stop);
			change('Failed');
			await input.save();
			await joined;
			expect(changed).toBe(true);
			expect(input.pending).toBeUndefined();
			expect(rows.calls.length + files.calls.length).toBe(2);
			expect(await stored(path)).toContain('New input');
		});
	}
}

for (const kind of ['row', 'text', 'fields'] as const) {
	test(`${kind}: close drains input accepted while a successful save clears`, async () => {
		const { folder, engine, edit, observe, observeFile, stored } =
			await setup();
		const path = 'notes/milk.md';
		const row = await observe();
		const bytes = await observeFile(path);
		const text = folder.files.edit(path);
		const input = kind === 'row' ? edit : text;
		const change = (title: string) => {
			if (kind === 'row') return edit.change(row, { fields: { title } });
			if (kind === 'text')
				return text.change(bytes, decode(bytes).replace('Milk', title));
			return text.changeFields(bytes, { title });
		};
		const rows = intercept(engine.tables.notes, 'set');
		const files = intercept(engine.files, 'write');
		let changed = false;
		let closing: Promise<unknown> | undefined;
		change('First');
		const stop = input.subscribe(() => {
			if (changed || input.pending !== undefined) return;
			changed = true;
			expect(change('New input')).toBe(true);
			closing = folder.close();
		});
		cleanup.push(stop);
		await input.save();
		await closing;
		expect(changed).toBe(true);
		expect(input.pending).toBeUndefined();
		expect(rows.calls.length + files.calls.length).toBe(2);
		expect(await stored(path)).toContain('New input');
	});
}

for (const outcome of ['success', 'failure'] as const) {
	for (const request of ['microtask save', 'settle'] as const) {
		test(`${outcome}: ${request} cannot join a drain that already stopped`, async () => {
			const { folder, engine, edit, observe, stored } = await setup();
			const row = await observe();
			const sets = intercept(engine.tables.notes, 'set');
			const restore = outcome === 'failure' ? fillDisk() : () => {};
			edit.change(row, { fields: { title: 'First' } });
			let asked = false;
			const requested = Promise.withResolvers<unknown>();
			const stop = edit.subscribe(() => {
				if (asked) return;
				if (
					outcome === 'success'
						? edit.pending !== undefined
						: edit.pending?.error === undefined
				)
					return;
				asked = true;
				const next = () => {
					restore();
					edit.change(row, { fields: { title: 'New input' } });
					const saving = request === 'settle' ? folder.settle() : edit.save();
					saving.then(requested.resolve, requested.reject);
				};
				if (request === 'microtask save') queueMicrotask(next);
				else next();
			});
			cleanup.push(stop);
			await edit.save();
			await requested.promise;
			expect(asked).toBe(true);
			expect(edit.pending).toBeUndefined();
			expect(sets.calls).toHaveLength(2);
			expect(await stored('notes/milk.md')).toContain('New input');
		});
	}
}
