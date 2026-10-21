/**
 * Folder Edit Owner Tests
 *
 * Drives the edit handles of a real browser folder on an in-memory IndexedDB
 * (`folder.tables.<name>.edit(id)`, `folder.files.edit(path)`), with a second
 * handle standing in for another writer. Each edit reads and shows its own
 * document; no UI framework or query cache takes part. Engine operations
 * below the handle are intercepted to hold or count reads and saves.
 *
 * Key behaviors:
 * - Making, subscribing to and reading an edit writes nothing; a missing
 *   file reads as `undefined`, and nothing read yet is no source to type over
 * - A landed save shows what storage kept without a reread; a read that
 *   started before it changes nothing, one that started after its commit
 *   wins, and a failed read keeps what is shown
 * - Another handle's change is read again for a path someone subscribes to
 *   or holds input for; another path keeps what it read, to type over, and
 *   reads it again once someone subscribes
 * - An older read's failure never replaces the status of a newer read
 * - One whole-source draft stays pinned across outside reads; a changed
 *   stored source conflicts at save, and explicit recovery chooses the source
 * - Typing during a save stays visible; a structured change over malformed
 *   fields is refused while the exact raw source remains repairable
 * - A change is nested fields and body, taken as one change
 * - The folder owns input from construction: autosave, status, settle and
 *   close work with no view and no subscriber; close waits for saves, not
 *   reads, and answers what did not save
 * - Admitted work keeps using the folder's own storage while close drains
 *   it; new actions, input and listeners refuse at once, storage only once
 *   close released it, and close never releases under a write it accepted
 * - A reservation holds until writes already queued on its paths finish
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openRepository } from './browser/repository.js';
import { openFolder } from './browser.js';
import { CLOSING, DELETING, mergeText, type ReadStatus } from './edits.js';
import type { FileContent, FolderChange, FolderStatus } from './folder.js';
import type { FolderEngine } from './handle.js';
import { folderHandle } from './handle.js';
import { openFolder as openAutomatic } from './index.js';
import { ReadError, SaveError } from './shared/errors.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
/** A table whose rows have a frontmatter field named `body`. */
const letters = Type.Object({ title: Type.String(), body: Type.String() });
const tables = { notes, letters };

const MILK = 'notes/milk.md';

for (const input of ['a\0b', `a\uD800b`]) {
	test(`a held nontext source stays exact in both FileEdit projections: ${JSON.stringify(input)}`, async () => {
		const { folder } = await openOverEngine();
		expectOk(await folder.files.write('a.md', null, 'before\n'));
		const edit = folder.files.edit('a.md');
		expectOk(await edit.read());
		expectOk(edit.replaceText(input));
		expect(edit.getText()).toBe(input);
		expect(edit.getMarkdown()?.text).toBe(input);
		expect(edit.getMarkdown()?.body).toBeUndefined();
		await edit.save();
		expect(edit.getPending()).toMatchObject({ text: input });
	});
}

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
	const edit = folder.tables.notes.edit('milk');
	/** Resolves once this folder heard another handle change `path`. */
	const heard = (path: string) =>
		new Promise<void>((resolve) => {
			const stop = folder.onChange((change) => {
				if (
					change.origin === 'other-handle' &&
					(change.paths === null || change.paths.includes(path))
				) {
					stop();
					resolve();
				}
			});
		});
	/** What is stored at `path`, read by the other writer. */
	const stored = async (path: string) => {
		const file = expectOk(await other.files.read(path));
		return file === undefined ? undefined : await file.content.text();
	};
	/** Another writer's change of `milk`, from what it read, once this folder heard it. */
	const elsewhere = async (change: {
		fields?: Partial<{ title: string; done: boolean }>;
		body?: string;
	}) => {
		const notice = heard(MILK);
		const from = expectOk(await other.tables.notes.get('milk'));
		expectOk(await other.tables.notes.set('milk', from ?? null, change));
		await notice;
	};
	/** Another writer's save of a file, once this folder heard it. */
	const writeElsewhere = async (
		path: string,
		from: FileContent | null,
		content: FileContent,
	) => {
		const notice = heard(path);
		expectOk(await other.files.write(path, from, content));
		await notice;
	};
	return {
		folder,
		engine,
		other,
		edit,
		/** Read `milk` into its edit; answers the row it shows. */
		load: async () => {
			expectOk(await edit.read());
			const row = edit.getMarkdown();
			if (row === undefined) throw new Error('milk is not stored');
			return row;
		},
		stored,
		elsewhere,
		writeElsewhere,
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

/**
 * Replace `target[key]` so its next call does its work, then waits before
 * answering: a read that read old content, or a save that committed, still
 * on its way back.
 */
function holdAnswer<TTarget extends object, TKey extends keyof TTarget>(
	target: TTarget,
	key: TKey,
) {
	const original = target[key] as unknown as (
		...args: unknown[]
	) => Promise<unknown>;
	const done = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let first = true;
	target[key] = (async (...args: unknown[]) => {
		if (!first) return original(...args);
		first = false;
		const result = await original(...args);
		done.resolve();
		await gate.promise;
		return result;
	}) as TTarget[TKey];
	cleanup.push(() => {
		gate.resolve();
		target[key] = original as TTarget[TKey];
	});
	return { done: done.promise, release: () => gate.resolve() };
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
// The document an edit shows
// ============================================================================

test('making, subscribing to and reading edits writes nothing, and a read answers the row', async () => {
	const { folder, engine } = await setup();
	const writes = intercept(engine.files, 'write');
	const sets = intercept(engine.files, 'write');
	const deletes = intercept(engine.files, 'delete');
	const statuses: FolderStatus[] = [];
	cleanup.push(folder.onStatusChange((status) => statuses.push(status)));

	const edit = folder.tables.notes.edit('milk');
	expect(edit.path).toBe(MILK);
	expect(edit.getMarkdown()).toBeUndefined();
	expect(edit.getPending()).toBeUndefined();
	expect(edit.isLocked()).toBe(false);
	const stop = edit.subscribe(() => {});
	expectOk(await edit.read());
	const row = edit.getMarkdown();
	expect(row).toMatchObject({
		fields: { title: 'Milk', done: false },
		body: 'Two litres\n',
		issues: null,
	});
	expect(edit.getMarkdown()).toBe(row);
	expect(edit.getMarkdown()).toBe(edit.getMarkdown());
	const text = folder.files.edit(MILK);
	expectOk(await text.read());
	expect(text.getText()).toBe(row?.text);
	expectOk(await folder.tables.notes.list());
	stop();

	expect(writes.calls).toEqual([]);
	expect(sets.calls).toEqual([]);
	expect(deletes.calls).toEqual([]);
	expect(statuses).toEqual([]);
});

test('a missing file reads as undefined, and nothing read is no source to type over', async () => {
	const { folder } = await setup();
	const ghost = folder.tables.notes.edit('ghost');
	expect(expectErr(ghost.change({ fields: { title: 'x' } })).name).toBe(
		'NoSource',
	);
	expectOk(await ghost.read());
	expect(ghost.getMarkdown()).toBeUndefined();
	expect(ghost.getMarkdown()).toBeUndefined();
	expect(expectErr(ghost.change({ body: 'x' })).name).toBe('NoSource');
	const file = folder.files.edit('notes/ghost.txt');
	expect(expectOk(await file.read())).toBeUndefined();
	expect(expectErr(file.replaceText('x')).name).toBe('NoSource');
	expect(expectErr(file.change({ fields: { title: 'x' } })).name).toBe(
		'NoSource',
	);
	expect(folder.getStatus().unsaved).toEqual([]);
});

test('row lists and gets answer the documents of their rows; a file read only one held', async () => {
	const { folder, engine } = await setup();
	const reads = intercept(engine.files, 'read');
	expectOk(await folder.tables.notes.list());
	const edit = folder.tables.notes.edit('milk');
	expect(edit.getMarkdown()?.fields?.title).toBe('Milk');
	expectOk(await folder.files.write('notes/a.txt', null, 'one\n'));
	expectOk(await folder.files.read('notes/a.txt'));
	// Text reads seed the shared owner before a control needs its source.
	expect(folder.files.edit('notes/a.txt').getText()).toBe('one\n');
	expect(reads.calls).toHaveLength(1);

	expectOk(await folder.tables.notes.get('milk'));
	expectOk(
		await folder.tables.notes.set('bread', null, {
			fields: { title: 'Bread', done: false },
		}),
	);
	expectOk(await folder.tables.notes.list());
	expect(folder.tables.notes.edit('bread').getMarkdown()?.fields?.title).toBe(
		'Bread',
	);
	// A row the list no longer has is gone.
	expectOk(
		await folder.tables.notes.delete(
			'bread',
			folder.tables.notes.edit('bread').getMarkdown() ?? null,
		),
	);
	expectOk(await folder.tables.notes.list());
	expect(folder.tables.notes.edit('bread').getMarkdown()).toBeUndefined();
});

test('a file read of a path an edit holds keeps its document current', async () => {
	const { folder, engine, writeElsewhere } = await setup();
	const path = 'notes/a.txt';
	expectOk(await folder.files.write(path, null, 'one\n'));
	const text = folder.files.edit(path);
	cleanup.push(text.subscribe(() => {}));
	expectOk(await text.read());
	expect(text.getText()).toBe('one\n');
	// The reread the outside change asks for never answers.
	const read = engine.files.read;
	let hung = false;
	engine.files.read = (target) => {
		if (hung) return read(target);
		hung = true;
		return new Promise(() => {});
	};
	await writeElsewhere(path, 'one\n', 'two\n');
	expect(text.getText()).toBe('one\n');

	expectOk(await folder.files.read(path));
	expect(text.getText()).toBe('two\n');
	engine.files.read = read;
});

test('a read that started before an own save landed changes nothing; the caller still gets what it read', async () => {
	const { folder, engine, edit, load } = await setup();
	await load();
	const getting = holdAnswer(engine.tables.notes, 'get');
	const old = folder.tables.notes.get('milk');
	await getting.done;
	const reading = holdAnswer(engine.files, 'read');
	const oldRead = edit.read();
	await reading.done;

	expectOk(edit.change({ fields: { title: 'Mine' } }));
	await edit.save();
	getting.release();
	reading.release();
	expect(expectOk(await old)?.fields?.title).toBe('Milk');
	// A read that a save overtook still answers what the edit shows.
	expectOk(await oldRead);
	expect(edit.getMarkdown()?.fields?.title).toBe('Mine');
	expect(edit.getMarkdown()?.fields?.title).toBe('Mine');
});

test('a read that started after a save committed and before it answered is newer than the save', async () => {
	const { folder, engine, other, edit, load, stored } = await setup();
	await load();
	const committing = holdAnswer(engine.files, 'write');
	expectOk(edit.change({ fields: { title: 'Mine' } }));
	const saving = edit.save();
	await committing.done;
	// Another writer replaces it, and this folder reads that.
	const current = expectOk(await other.tables.notes.get('milk'));
	expectOk(
		await other.tables.notes.set('milk', current ?? null, {
			fields: { title: 'Outside' },
		}),
	);
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields?.title).toBe(
		'Outside',
	);
	committing.release();
	await saving;

	expect(await stored(MILK)).toContain('title: Outside');
	expect(edit.getMarkdown()?.fields?.title).toBe('Outside');
});

test('a save that committed before an outside change shows until the reread answers, never the older row', async () => {
	const { engine, edit, load, elsewhere } = await setup();
	const shown: unknown[] = [];
	cleanup.push(
		edit.subscribe(() => shown.push(edit.getMarkdown()?.fields?.title)),
	);
	await load();
	const committing = holdAnswer(engine.files, 'write');
	expectOk(edit.change({ fields: { title: 'Mine' } }));
	const saving = edit.save();
	await committing.done;
	const reads = intercept(engine.files, 'read');
	reads.hold();
	await elsewhere({ body: 'Outside\n' });
	committing.release();
	await saving;
	expect(edit.getPending()).toBeUndefined();
	expect(edit.getMarkdown()).toMatchObject({
		fields: { title: 'Mine' },
		body: 'Two litres\n',
	});

	reads.release();
	await until(() => edit.getMarkdown()?.body === 'Outside\n');
	expect(edit.getMarkdown()?.fields?.title).toBe('Mine');
	expect(shown.slice(shown.indexOf('Mine'))).not.toContain('Milk');
});

test('a failed read keeps what the edit shows, held input included, and says why', async () => {
	const { engine, edit, load } = await setup();
	await load();
	expectOk(edit.change({ body: 'Typed\n' }));
	const read = engine.files.read;
	engine.files.read = async () =>
		ReadError.StorageFailed({ cause: new Error('The disk is gone') });
	const failed = await edit.read();
	engine.files.read = read;

	expect(expectErr(failed).name).toBe('StorageFailed');
	expect(edit.getMarkdown()).toMatchObject({
		fields: { title: 'Milk' },
		body: 'Typed\n',
	});
	expect(edit.getPending()?.text).toBe(edit.getText());
});

test("another handle's change is read again for a subscribed path; another path keeps what it read until someone subscribes", async () => {
	const { folder, other, edit, load, elsewhere } = await setup();
	const heard: number[] = [];
	cleanup.push(edit.subscribe(() => heard.push(1)));
	await load();
	expectOk(
		await folder.tables.notes.set('bread', null, {
			fields: { title: 'Bread', done: false },
		}),
	);
	const bread = folder.tables.notes.edit('bread');
	expectOk(await bread.read());

	await elsewhere({ fields: { done: true } });
	await until(() => edit.getMarkdown()?.fields?.done === true);
	expect(heard.length).toBeGreaterThan(0);

	const notice = new Promise<void>((resolve) => {
		const stop = folder.onChange((change) => {
			if (change.paths?.includes('notes/bread.md')) {
				stop();
				resolve();
			}
		});
	});
	const from = expectOk(await other.tables.notes.get('bread'));
	expectOk(
		await other.tables.notes.set('bread', from ?? null, { body: 'Rye\n' }),
	);
	await notice;
	// Nobody shows bread: what was read stays, to type over, and is read again
	// once someone subscribes.
	expect(bread.getMarkdown()?.body).toBe('');
	cleanup.push(bread.subscribe(() => {}));
	await until(() => bread.getMarkdown()?.body === 'Rye\n');
});

test('a view that subscribes again in the same turn keeps its document; the last to leave lets it go', async () => {
	const { edit, load } = await setup();
	const first = edit.subscribe(() => {});
	await load();
	const row = edit.getMarkdown();
	first();
	const second = edit.subscribe(() => {});
	await Promise.resolve();
	expect(edit.getMarkdown()).toBe(row);
	second();
	await Promise.resolve();
	expect(edit.getMarkdown()).toBeUndefined();
});

test('the read status says what is known and how reading goes, the same value until it changes', async () => {
	const { folder, engine, edit } = await setup();
	const statuses = [edit.getReadStatus()];
	cleanup.push(
		edit.subscribe(() => {
			const status = edit.getReadStatus();
			if (status !== statuses.at(-1)) statuses.push(status);
		}),
	);
	expect(edit.getReadStatus()).toBe(statuses[0] as ReadStatus);
	const reading = edit.read();
	expect(edit.getReadStatus()).toEqual({
		known: 'nothing',
		reading: true,
		error: undefined,
	});
	expectOk(await reading);
	expect(statuses).toEqual([
		{ known: 'nothing', reading: false, error: undefined },
		{ known: 'nothing', reading: true, error: undefined },
		{ known: 'file', reading: true, error: undefined },
		{ known: 'file', reading: false, error: undefined },
	]);
	// Typing changes the row, not the status.
	const status = edit.getReadStatus();
	expectOk(edit.change({ fields: { title: 'Oat milk' } }));
	expect(edit.getReadStatus()).toBe(status);

	// A failed refresh keeps the row and says why.
	const read = engine.files.read;
	engine.files.read = async () =>
		ReadError.StorageFailed({ cause: new Error('gone') });
	expectErr(await edit.read());
	engine.files.read = read;
	expect(edit.getReadStatus()).toMatchObject({
		known: 'file',
		reading: false,
		error: { name: 'StorageFailed' },
	});
	expect(edit.getMarkdown()?.fields?.title).toBe('Oat milk');
	expectOk(await edit.read());
	expect(edit.getReadStatus().error).toBeUndefined();

	const ghost = folder.tables.notes.edit('ghost');
	expectOk(await ghost.read());
	expect(ghost.getReadStatus().known).toBe('missing');
});

for (const known of [false, true])
	test(`reads joining a running read share its failure (${known ? 'a refresh' : 'the first read'})`, async () => {
		const { engine, edit, load } = await setup();
		if (known) await load();
		const read = engine.files.read;
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		engine.files.read = async () => {
			calls++;
			await gate.promise;
			return ReadError.StorageFailed({ cause: new Error('gone') });
		};
		const first = edit.read();
		const second = edit.read();
		gate.resolve();
		const outcomes = await Promise.all([first, second]);
		engine.files.read = read;
		expect(calls).toBe(1);
		expect(outcomes.map(({ error }) => error?.name)).toEqual([
			'StorageFailed',
			'StorageFailed',
		]);
		expect(edit.getReadStatus()).toMatchObject({
			known: known ? 'file' : 'nothing',
			error: { name: 'StorageFailed' },
		});
		expect(edit.getMarkdown()?.fields?.title).toBe(known ? 'Milk' : undefined);
	});

test('a read overtaken by another handle’s change answers what was read, then what the reread found', async () => {
	const { engine, edit, writeElsewhere, stored } = await setup();
	const reading = holdAnswer(engine.files, 'read');
	const first = edit.read();
	await reading.done;
	// Nobody subscribes; the read running is what wants the change read.
	const from = (await stored(MILK)) ?? '';
	await writeElsewhere(MILK, from, from.replace('Milk', 'Outside'));
	reading.release();
	expectOk(await first);
	expect(edit.getMarkdown()?.fields?.title).toBe('Outside');
	expect(edit.getReadStatus()).toMatchObject({ known: 'file', reading: false });
});

test('an older read that fails after a newer read succeeded tells its own caller, not the status', async () => {
	const { engine, edit, load, writeElsewhere, stored } = await setup();
	cleanup.push(edit.subscribe(() => {}));
	await load();
	const read = engine.files.read;
	const gate = Promise.withResolvers<void>();
	let first = true;
	engine.files.read = async (path) => {
		if (!first) return read(path);
		first = false;
		await gate.promise;
		return ReadError.StorageFailed({ cause: new Error('gone') });
	};
	cleanup.push(() => {
		gate.resolve();
		engine.files.read = read;
	});
	const old = edit.read();
	// Another handle's change: the reread it asks for is newer than the old read.
	const from = (await stored(MILK)) ?? '';
	await writeElsewhere(MILK, from, from.replace('Milk', 'Outside'));
	expectOk(await edit.read());
	expect(edit.getMarkdown()?.fields?.title).toBe('Outside');
	expect(edit.getReadStatus().error).toBeUndefined();

	gate.resolve();
	expect(expectErr(await old).name).toBe('StorageFailed');
	expect(edit.getReadStatus()).toMatchObject({
		known: 'file',
		reading: false,
		error: undefined,
	});
	expect(edit.getMarkdown()?.fields?.title).toBe('Outside');
});

test('row and text snapshots of one path keep their identity side by side', async () => {
	const { folder, edit, load } = await setup();
	await load();
	expectOk(edit.change({ fields: { title: 'Oat milk' } }));
	const text = folder.files.edit(MILK);
	const row = edit.getMarkdown();
	const source = text.getText();
	expect(edit.getMarkdown()).toBe(row);
	expect(text.getText()).toBe(source);
	expect(edit.getMarkdown()).toBe(row);
	// Both projections include the same unsaved input.
	expect(row?.fields?.title).toBe('Oat milk');
	expect(source).toContain('title: Oat milk');
});

test('a file that is not text shows no text, refuses typing, and keeps its bytes', async () => {
	const { folder, engine, stored } = await setup();
	const writes = intercept(engine.files, 'write');
	for (const [path, bytes] of [
		['notes/raw.md', new Uint8Array([255, 254, 0])],
		['notes/zero.md', new TextEncoder().encode('---\ntitle: x\n---\na\0b\n')],
	] as const) {
		expectOk(await folder.files.write(path, null, bytes));
		const text = folder.files.edit(path);
		expectOk(await text.read());
		expect(text.getText()).toBeUndefined();
		expect(text.getReadStatus()).toMatchObject({ known: 'not-text' });
		expect(text.getText()).toBeUndefined();
		expect(expectErr(text.replaceText('repaired')).name).toBe('NotText');
		expect(expectErr(text.change({ fields: { title: 'x' } })).name).toBe(
			'NotText',
		);
		const row = folder.tables.notes.edit(path.slice(6, -3));
		expectOk(await row.read());
		expect(row.getMarkdown()).toBeUndefined();
		expect(row.getReadStatus().known).toBe('not-text');
		expect(expectErr(row.change({ body: 'x' })).name).toBe('NotText');
		const file = expectOk(await folder.files.read(path));
		expect(new Uint8Array(await file!.content.arrayBuffer())).toEqual(bytes);
	}
	expect(writes.calls).toHaveLength(2);
	// The low-level write stays the repair.
	expectOk(
		await folder.files.write(
			'notes/raw.md',
			new Uint8Array([255, 254, 0]),
			'text\n',
		),
	);
	expect(await stored('notes/raw.md')).toBe('text\n');
});

test('a row shows held input in its source, read again: fields, body, text and issues agree', async () => {
	const { folder, edit, load, writeElsewhere, stored } = await setup();
	await load();
	expectOk(edit.change({ fields: { title: undefined } }));
	const removed = edit.getMarkdown();
	expect(removed?.issues?.[0]?.kind).toBe('schema');
	expect(removed?.text).not.toContain('title:');
	expect(removed?.fields).toEqual({ done: false });
	expectOk(edit.change({ fields: { title: 'Oat milk' }, body: 'Three\n' }));
	expect(edit.getMarkdown()).toMatchObject({
		issues: null,
		fields: { title: 'Oat milk', done: false },
		body: 'Three\n',
		text: '---\ndone: false\ntitle: Oat milk\n---\nThree\n',
	});
	// Fields that cannot be written are refused at once.
	expect(
		expectErr(
			edit.change({ fields: { title: (() => 'x') as unknown as string } }),
		).name,
	).toBe('InvalidFields');

	// The outside header is known, while the local draft remains pinned.
	cleanup.push(edit.subscribe(() => {}));
	const broken = '---\ntitle: [broken\n---\nTwo litres\n';
	await writeElsewhere(MILK, (await stored(MILK)) ?? null, broken);
	expectOk(await edit.read());
	expect(edit.getMarkdown()).toMatchObject({
		text: '---\ndone: false\ntitle: Oat milk\n---\nThree\n',
		fields: { title: 'Oat milk', done: false },
		body: 'Three\n',
	});
	expect(edit.getPending()?.text).toBe(edit.getText());
	expect(folder.files.edit(MILK).getText()).toBe(edit.getText());
});

test('an action, a direct save and a status subscription hold no document; an explicit read does', async () => {
	const { folder } = await setup();
	const path = 'audio/take.bin';
	const audio = folder.files.edit(path);
	const stop = audio.subscribe(() => {});
	expectOk(
		await folder.run([path], async () =>
			folder.files.write(path, null, new Uint8Array([1, 2, 3])),
		),
	);
	expectOk(
		await folder.files.write(
			path,
			new Uint8Array([1, 2, 3]),
			new Uint8Array([4]),
		),
	);
	expect(folder.files.edit(path).getReadStatus().known).toBe('nothing');
	expect(audio.getText()).toBeUndefined();
	stop();

	const note = 'notes/plain.txt';
	expectOk(await folder.files.write(note, null, 'one\n'));
	const text = folder.files.edit(note);
	expectOk(await text.read());
	expect(text.getText()).toBe('one\n');
	await Bun.sleep(5);
	expect(text.getText()).toBe('one\n');
	expectOk(text.replaceText('two\n'));
	await text.save();
	expect(text.getText()).toBe('two\n');
});

// ============================================================================
// Bases
// ============================================================================

test('a body typed over broken frontmatter lands without touching the header', async () => {
	const { folder, edit, stored } = await setup();
	expectOk(
		await folder.files.write(
			MILK,
			(await stored(MILK)) ?? null,
			'---\ntitle: [broken\n---\nTwo litres\n',
		),
	);
	await edit.read();
	edit.change({ body: 'Repaired by hand' });
	await edit.save();

	expect(edit.getPending()).toBeUndefined();
	expect(await stored(MILK)).toBe('---\ntitle: [broken\n---\nRepaired by hand');
});

test('a row change while a save runs replaces what is held, so a revert saves', async () => {
	const { engine, edit, load, stored } = await setup('one\ntwo\nthree\n');
	await load();
	const sets = intercept(engine.files, 'write');
	edit.change({ body: 'ONE\ntwo\nthree\n' });
	const started = sets.next();
	sets.hold();
	const first = edit.save();
	await started;
	expect(edit.getMarkdown()?.body).toBe('ONE\ntwo\nthree\n');
	edit.change({ body: 'one\ntwo\nthree\n' });
	sets.release();
	await first;
	await edit.save();

	expect(await stored(MILK)).toBe(
		'---\ndone: false\ntitle: Milk\n---\none\ntwo\nthree\n',
	);
	type Call = [string, string, string, boolean];
	const [, [, secondFrom, secondChange]] = sets.calls as [Call, Call];
	expect(secondFrom.endsWith('---\nONE\ntwo\nthree\n')).toBe(true);
	expect(secondChange.endsWith('---\none\ntwo\nthree\n')).toBe(true);
});

test('a text change while a save runs replaces the held text and starts from what was sent', async () => {
	for (const revert of [false, true]) {
		const { folder, engine, stored } = await setup();
		const path = 'notes/list.txt';
		expectOk(await folder.files.write(path, null, 'one\ntwo\nthree\n'));
		const writes = intercept(engine.files, 'write');
		const text = folder.files.edit(path);
		expectOk(await text.read());
		expect(text.getText()).toBe('one\ntwo\nthree\n');
		text.replaceText('ONE\ntwo\nthree\n');
		const started = writes.next();
		writes.hold();
		const first = text.save();
		await started;
		expect(text.getText()).toBe('ONE\ntwo\nthree\n');
		text.replaceText(revert ? 'one\ntwo\nthree\n' : 'ONE\ntwo\nthree typed\n');
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

test('mergeText puts what a change did to its base into the current text, the change winning a shared line', () => {
	expect(mergeText('one\ntwo\n', 'ONE\ntwo\n', 'one\nTWO\n')).toBe(
		'ONE\nTWO\n',
	);
	expect(mergeText('one\ntwo\n', 'one\ntwo\n', 'one\nTWO\n')).toBe(
		'one\nTWO\n',
	);
	expect(mergeText('one\n', 'One\n', 'ONE\n')).toBe('ONE\n');
});

test('a save asked for while a save starts joins it, and typing goes on in order', async () => {
	const { folder, engine, stored } = await setup();
	const path = 'notes/reentrant.txt';
	expectOk(await folder.files.write(path, null, 'a\n'));
	const text = folder.files.edit(path);
	await text.read();
	const writes = intercept(engine.files, 'write');
	writes.hold();
	let asked = 0;
	const stop = text.subscribe(() => {
		if (asked === 0 && text.getPending()?.saving === true) {
			asked++;
			void text.save();
		}
	});
	cleanup.push(stop);
	text.replaceText('b\n');
	const saving = text.save();
	expect(asked).toBe(1);
	text.replaceText('c\n');
	writes.release();
	await saving;
	await text.save();
	expect(writes.calls.map(([, , content]) => content)).toEqual(['b\n', 'c\n']);
	expect(await stored(path)).toBe('c\n');
});

test('from close on, save sends nothing new and the held input stays', async () => {
	const { folder, engine, stored } = await setup();
	const path = 'notes/late.txt';
	expectOk(await folder.files.write(path, null, 'a\n'));
	const text = folder.files.edit(path);
	await text.read();
	text.replaceText('b\n');
	const writes = intercept(engine.files, 'write');
	const restore = fillDisk();
	const closing = folder.close();
	// Asked for while close runs: it joins close.
	const during = text.save();
	const unsaved = await closing;
	await during;
	expect(unsaved).toMatchObject([{ path, text: 'b\n' }]);
	restore();
	const sent = writes.calls.length;

	await text.save();
	expect(writes.calls).toHaveLength(sent);
	expect(text.getPending()).toMatchObject({
		text: 'b\n',
		error: { name: 'StorageFailed' },
	});
	expect(text.getText()).toBe('b\n');
	await expect(text.read()).rejects.toThrow('closed');
	expect(await stored(path)).toBe('a\n');
});

// ============================================================================
// One queue per path
// ============================================================================

test('two own saves of one path started before either lands run one at a time', async () => {
	const { folder, engine, other, edit, load, stored } = await setup();
	const write = engine.files.write;
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
	engine.files.write = async (...args) => {
		if (calls++ === 0) {
			reached.first.resolve();
			await gates.firstCommit.promise;
			const result = await write(...args);
			reached.committed.resolve();
			await gates.firstReturn.promise;
			return result;
		}
		return write(...args);
	};
	engine.tables.notes.set = async (...args) => {
		calls++;
		reached.second.resolve();
		await gates.second.promise;
		return set(...args);
	};
	cleanup.push(() => {
		for (const gate of Object.values(gates)) gate.resolve();
	});
	const old = await load();
	edit.change({ fields: { title: 'Mine' } });
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
	// The edit shows the outside title under the input still saving.
	expectOk(await edit.read());
	expect(edit.getMarkdown()?.fields?.title).toBe('Mine');
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields?.title).toBe(
		'Outside',
	);

	// The direct save waits for the first, and starts only once it returned.
	await Bun.sleep(5);
	expect(calls).toBe(1);
	gates.firstReturn.resolve();
	await first;
	await reached.second.promise;
	gates.second.resolve();
	// Read after the first save committed, the outside title is newer than it.
	expect(edit.getMarkdown()?.fields?.title).toBe('Outside');
	expectOk(await second);

	expect(await stored(MILK)).toBe(
		'---\ndone: true\ntitle: Outside\n---\nTwo litres\n',
	);
	expect(edit.getMarkdown()?.text).toBe(await stored(MILK));
});

test('a direct row save takes its change as it was at the call, queued or not', async () => {
	for (const queued of [false, true]) {
		const { folder, engine, load } = await setup();
		const sets = intercept(engine.tables.notes, 'set');
		let first: Promise<unknown> | undefined;
		if (queued) {
			const started = sets.next();
			sets.hold();
			first = folder.tables.notes.set('milk', await load(), {
				fields: { done: true },
			});
			await started;
		}
		const row = await load();
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
		const { folder, engine, load } = await setup();
		const sets = intercept(engine.tables.notes, 'set');
		let first: Promise<unknown> | undefined;
		if (queued) {
			const started = sets.next();
			sets.hold();
			first = folder.tables.notes.set('milk', await load(), {
				fields: { done: true },
			});
			await started;
		}
		const refused = await folder.tables.notes.set('milk', await load(), {
			fields: { title: (() => 'a function') as unknown as string },
		});
		expect(expectErr(refused).name).toBe('Unparseable');
		sets.release();
		await first;
		await folder.close();
	}
});

test('a direct set answers the row it submitted; the edit shows what storage kept', async () => {
	const { folder, engine, edit, load, elsewhere } = await setup();
	cleanup.push(edit.subscribe(() => {}));
	const old = await load();
	// The reread the outside change asks for never answers.
	intercept(engine.files, 'read').hold();
	await elsewhere({ body: 'Outside\n' });
	const saved = expectOk(
		await folder.tables.notes.set('milk', old, { fields: { title: 'Mine' } }),
	);
	expect(saved.sent).toMatchObject({
		fields: { title: 'Mine' },
		body: 'Two litres\n',
	});
	expect(edit.getMarkdown()).toMatchObject({
		fields: { title: 'Mine' },
		body: 'Outside\n',
	});
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

test('an unchanged local command sends no save or path change', async () => {
	const { folder, edit, load } = await setup();
	const heard: FolderChange[] = [];
	cleanup.push(folder.onChange((change) => heard.push(change)));
	await load();
	edit.change({ fields: { title: 'Milk' } });
	await edit.save();
	expect(heard).toEqual([]);

	edit.change({ fields: { title: 'Oat milk' } });
	await edit.save();
	expect(heard).toHaveLength(1);
});

// ============================================================================
// Handles
// ============================================================================

test('handles are passive and share one document and input whose identity holds until it changes', async () => {
	const { folder } = await setup();
	let heard = 0;
	const first = folder.tables.notes.edit('milk');
	const stop = first.subscribe(() => heard++);
	const second = folder.tables.notes.edit('milk');
	expect(first.getPending()).toBeUndefined();
	expect(heard).toBe(0);

	await second.read();
	const shown = first.getMarkdown();
	expect(second.getMarkdown()).toBe(shown);
	// The read's start, answer and end.
	expect(heard).toBe(3);
	heard = 0;
	first.change({ fields: { title: 'Oat milk' } });
	const pending = second.getPending();
	expect(pending).toBe(first.getPending());
	expect(pending).toMatchObject({
		path: MILK,
		text: first.getText(),
		saving: false,
	});
	expect(Object.keys(pending ?? {})).not.toContain('bases');
	expect(second.getMarkdown()).not.toBe(shown);
	expect(second.getMarkdown()?.fields?.title).toBe('Oat milk');
	expect(heard).toBe(1);

	stop();
	second.discard();
	expect(heard).toBe(1);
	expect(first.getPending()).toBeUndefined();
});

test('text saves exactly what was typed and newer typing keeps its source', async () => {
	const { folder, stored } = await setup();
	const path = 'notes/a.txt';
	const original = '﻿one\r\ntwo\r\n';
	expectOk(
		await folder.files.write(path, null, new TextEncoder().encode(original)),
	);
	const edit = folder.files.edit(path);
	expectOk(await edit.read());
	expect(edit.getText()).toBe(original);
	edit.replaceText('﻿one!\r\ntwo\r\n');
	edit.replaceText('﻿one!\r\ntwo?\r\n');
	await edit.save();

	expect(edit.getPending()).toBeUndefined();
	const saved = expectOk(await folder.files.read(path));
	expect(new Uint8Array(await saved!.content.arrayBuffer())).toEqual(
		new TextEncoder().encode('﻿one!\r\ntwo?\r\n'),
	);
	expect(edit.getText()).toBe('﻿one!\r\ntwo?\r\n');
	expect(await stored(path)).toBe('one!\r\ntwo?\r\n');
});

test('held text stays readable and typable over itself with nothing read', async () => {
	const { folder, engine } = await setup();
	const path = 'notes/u.txt';
	expectOk(await folder.files.write(path, null, 'old\n'));
	const text = folder.files.edit(path);
	cleanup.push(text.subscribe(() => {}));
	await text.read();
	const restore = fillDisk();
	text.replaceText('held\n');
	await text.save();
	restore();
	expect(text.getPending()?.error?.name).toBe('StorageFailed');
	// A read that fails leaves the held text where it was.
	const read = engine.files.read;
	engine.files.read = async () =>
		ReadError.StorageFailed({ cause: new Error('gone') });
	expect(expectErr(await text.read()).name).toBe('StorageFailed');
	engine.files.read = read;
	expect(text.getText()).toBe('held\n');
	expectOk(text.replaceText('held, more\n'));
	expect(text.getText()).toBe('held, more\n');
});

test('row and text views expose and change one path input without saving first', async () => {
	const { folder, edit: rowEdit, load, stored } = await setup();
	const textEdit = folder.files.edit(MILK);
	await load();
	expectOk(
		rowEdit.change({ fields: { title: 'Oat milk' }, body: 'Typed body\n' }),
	);
	expect(textEdit.getText()).toBe(rowEdit.getMarkdown()?.text);
	expect(textEdit.getPending()).toBe(rowEdit.getPending());
	expectOk(textEdit.change({ fields: { done: true } }));
	expect(rowEdit.getMarkdown()?.fields).toEqual({
		title: 'Oat milk',
		done: true,
	});
	expectOk(
		textEdit.replaceText(
			textEdit.getText()!.replace('Typed body', 'Whole text'),
		),
	);
	expect(rowEdit.getMarkdown()?.body).toBe('Whole text\n');
	expect(rowEdit.getPending()).toBe(textEdit.getPending());
	expectOk(
		rowEdit.change({ fields: { title: 'Milk' }, body: 'Back to row\n' }),
	);
	expect(textEdit.getText()).toBe(rowEdit.getMarkdown()?.text);
	expect(await stored(MILK)).toContain('Two litres');
	await rowEdit.save();
	expect(rowEdit.getPending()).toBeUndefined();
	expect(textEdit.getPending()).toBeUndefined();
	expect(await stored(MILK)).toBe(
		'---\ndone: true\ntitle: Milk\n---\nBack to row\n',
	);
});

test('row changes patch text during saving and preserve a deliberate revert', async () => {
	const { folder, engine, edit: rowEdit, load, stored } = await setup();
	const textEdit = folder.files.edit(MILK);
	await load();
	expectOk(
		textEdit.replaceText(textEdit.getText()!.replace('Milk', 'Oat milk')),
	);
	const writes = intercept(engine.files, 'write');
	const started = writes.next();
	writes.hold();
	const saving = textEdit.save();
	await started;
	expectOk(
		rowEdit.change({ fields: { title: 'Milk' }, body: 'Still typing\n' }),
	);
	writes.release();
	await saving;
	expect(rowEdit.getPending()).toBe(textEdit.getPending());
	expect(rowEdit.getMarkdown()?.fields?.title).toBe('Milk');
	await rowEdit.save();
	expect(await stored(MILK)).toContain('title: Milk');
	expect(await stored(MILK)).toContain('Still typing');
	expect(textEdit.getPending()).toBeUndefined();
});

test('either view can recover failed input, and switching views leaves the error held', async () => {
	for (const from of ['row', 'text'] as const) {
		const { folder, edit: rowEdit, load, stored } = await setup();
		const textEdit = folder.files.edit(MILK);
		await load();
		if (from === 'row') expectOk(rowEdit.change({ fields: { title: 'Held' } }));
		else
			expectOk(
				textEdit.replaceText(textEdit.getText()!.replace('Milk', 'Held')),
			);
		const restore = fillDisk();
		await rowEdit.save();
		expect(rowEdit.getPending()).toBe(textEdit.getPending());
		expect(textEdit.getPending()?.error?.name).toBe('StorageFailed');
		expect(textEdit.getText()).toContain('title: Held');
		expect(rowEdit.getMarkdown()?.fields?.title).toBe('Held');
		// Neither making another view nor asking for a read retries failed input.
		expect(folder.tables.notes.edit('milk').getPending()).toBe(
			textEdit.getPending(),
		);
		await textEdit.read();
		expect(rowEdit.getPending()?.error?.name).toBe('StorageFailed');
		restore();
		await (from === 'row' ? textEdit : rowEdit).save();
		expect(await stored(MILK)).toContain('title: Held');
		expect(textEdit.getPending()).toBeUndefined();
	}
});

// ============================================================================
// Failure, delete and close
// ============================================================================

test('a failed save keeps its input and error for copying or discard', async () => {
	const { folder, edit, load } = await setup();
	await load();
	const restore = fillDisk();
	expectOk(edit.change({ fields: { title: 'Oat milk' } }));
	await edit.save();

	expect(edit.getPending()?.error?.name).toBe('StorageFailed');
	expect(edit.getMarkdown()?.fields?.title).toBe('Oat milk');
	expect(folder.getStatus().failures[0]?.text).toBe(edit.getText());
	expect(folder.getStatus().storageFailure?.name).toBe('StorageFailed');
	expect(expectErr(await edit.delete()).name).toBe('NotStarted');
	restore();
	expect(edit.discard()?.text).toContain('title: Oat milk');
	expect(edit.getMarkdown()?.fields?.title).toBe('Milk');
	expect(folder.getStatus().unsaved).toEqual([]);
	expect(folder.getStatus().failures).toEqual([]);
});

test('a thrown storage call is a StorageFailed save that keeps its input to save again', async () => {
	const { folder, engine, edit, load } = await setup();
	await load();
	const set = engine.files.write;
	engine.files.write = async () => {
		throw new Error('transport disconnected');
	};
	edit.change({ fields: { title: 'Oat milk' } });
	await edit.save();
	expect(edit.getPending()?.error?.name).toBe('StorageFailed');

	engine.files.write = set;
	await edit.save();
	expect(edit.getPending()).toBeUndefined();
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields?.title).toBe(
		'Oat milk',
	);
});

test('a save asked for during a delete sends held input once and cannot restore the row', async () => {
	const { folder, engine, edit, load } = await setup();
	await load();
	edit.change({ fields: { title: 'Oat milk' } });
	const sets = intercept(engine.files, 'write');
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
	expect(edit.getPending()).toBeUndefined();
	expect(edit.getMarkdown()).toBeUndefined();
	expect(expectOk(await folder.tables.notes.get('milk'))).toBeUndefined();
});

test('a file delete keeps a file another writer changed after the delete read it', async () => {
	const { folder, engine, other, stored } = await setup();
	const path = 'notes/a.txt';
	expectOk(await folder.files.write(path, null, 'one'));
	const text = folder.files.edit(path);
	cleanup.push(text.subscribe(() => {}));
	await text.read();
	const deletes = intercept(engine.files, 'delete');
	const started = deletes.next();
	deletes.hold();
	const deleting = text.delete();
	await started;
	expectOk(await other.files.write(path, 'one', 'another writer'));
	deletes.release();

	expect(expectOk(await deleting)).toEqual({ deleted: false });
	expect(await stored(path)).toBe('another writer');
	// What the delete kept is read again for the view that shows it.
	await until(() => text.getText() === 'another writer');
});

test('delete fences input at once and removes the row after its held save', async () => {
	const { folder, edit, load } = await setup();
	await load();
	edit.change({ fields: { title: 'Oat milk' } });
	const deleting = edit.delete();
	expect(edit.isLocked()).toBe(true);
	expect(expectErr(edit.change({ fields: { title: 'Later' } }))).toMatchObject({
		name: 'Locked',
		reason: DELETING,
	});
	expect(folder.getStatus().saving).toBe(true);

	expect(expectOk(await deleting)).toEqual({ deleted: true });
	expect(edit.getPending()).toBeUndefined();
	expect(folder.getStatus().saving).toBe(false);
	expect(expectOk(await folder.tables.notes.get('milk'))).toBeUndefined();
});

test('close refuses input, actions and listeners at once while admitted work uses the folder until close releases it', async () => {
	const { folder, edit, load, stored } = await setup();
	await load();
	const text = folder.files.edit(MILK);
	const unseen = folder.files.edit('notes/unseen.md');
	expectOk(edit.change({ fields: { title: 'Accepted' } }));
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	cleanup.push(() => gate.resolve());
	const operation = folder.run([], async () => {
		entered.resolve();
		await gate.promise;
		expectOk(await folder.files.write('direct.txt', null, 'admitted work'));
		const row = expectOk(await folder.tables.notes.get('milk'));
		expect(row).toBeDefined();
		return expectOk(
			await folder.tables.notes.set('milk', row!, {
				body: 'finished during close',
			}),
		);
	});
	await entered.promise;
	const closing = folder.close();
	expect(folder.close()).toBe(closing);
	expect(folder.getStatus().closing).toBe(true);
	for (const view of [edit, text, unseen]) {
		expect(view.isLocked()).toBe(true);
		expect(expectErr(view.replaceText('too late')).name).toBe('Locked');
	}
	expect(expectErr(edit.change({ body: 'too late' })).name).toBe('Locked');
	expect(edit.discard()).toBeUndefined();
	await expect(text.read()).rejects.toThrow('The folder is closed');
	expect(() => folder.onChange(() => {})).toThrow('The folder is closed');
	expect(() => folder.onStatusChange(() => {})).toThrow('The folder is closed');
	await expect(folder.settle()).rejects.toThrow('The folder is closed');
	expect(expectErr(await folder.run([], async () => {}))).toMatchObject({
		name: 'NotStarted',
		reason: CLOSING,
	});
	gate.resolve();
	expectOk(await operation);
	expect(await closing).toEqual([]);
	expect(edit.getPending()).toBeUndefined();
	expect(await stored(MILK)).toContain('title: Accepted');
	expect(await stored(MILK)).toContain('finished during close');
	expect(await stored('direct.txt')).toBe('admitted work');
	// Released: ordinary storage refuses from here on.
	expect(() => folder.files.read(MILK)).toThrow('The folder is closed');
	expect(() => folder.tables.notes.get('milk')).toThrow('The folder is closed');
});

test('a multi-file scope reserves all paths synchronously and refuses overlaps without partial locks', async () => {
	const { folder, edit, load, stored } = await setup();
	await load();
	expectOk(edit.change({ fields: { title: 'Before operation' } }));
	const source = folder.files.edit(MILK);
	const second = folder.files.edit('audio/take.bin');
	const untouched = folder.files.edit('notes/untouched.md');
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const operation = folder.run([MILK, second.path, MILK], async () => {
		expect(await stored(MILK)).toContain('title: Before operation');
		expect(source.getPending()).toBeUndefined();
		entered.resolve();
		await gate.promise;
		return expectOk(
			await folder.files.write(second.path, null, new Uint8Array([1, 2])),
		);
	});
	expect(edit.isLocked()).toBe(true);
	expect(source.isLocked()).toBe(true);
	expect(second.isLocked()).toBe(true);
	expect(untouched.isLocked()).toBe(false);
	expect(
		expectErr(await folder.run([untouched.path, MILK], async () => {})).name,
	).toBe('NotStarted');
	expect(untouched.isLocked()).toBe(false);
	expect(
		expectErr(await folder.run([untouched.path, '../escape'], async () => {}))
			.name,
	).toBe('NotStarted');
	expect(untouched.isLocked()).toBe(false);
	expect(expectErr(await folder.run([source.path], async () => {})).name).toBe(
		'NotStarted',
	);
	await entered.promise;
	gate.resolve();
	expectOk(await operation);
	expect(edit.isLocked()).toBe(false);
	expect(second.isLocked()).toBe(false);
});

test('a scope waits for every running save then sends changes accepted while they ran', async () => {
	const { folder, engine, load, stored } = await setup();
	await load();
	expectOk(await folder.files.write('second.txt', null, 'before'));
	const first = folder.files.edit(MILK);
	const second = folder.files.edit('second.txt');
	expectOk(await second.read());
	const writes = intercept(engine.files, 'write');
	writes.hold();
	expectOk(first.replaceText('first save'));
	expectOk(second.replaceText('second save'));
	const saving = Promise.all([first.save(), second.save()]);
	await until(() => writes.calls.length === 2);
	expectOk(first.replaceText('new first input'));
	expectOk(second.replaceText('new second input'));
	let ran = false;
	const scope = folder.run([MILK, second.path], async () => {
		ran = true;
		expect(await stored(MILK)).toBe('new first input');
		expect(await stored(second.path)).toBe('new second input');
	});
	await Bun.sleep(0);
	expect(ran).toBe(false);
	writes.release();
	await saving;
	expectOk(await scope);
	expect(ran).toBe(true);
	expect(first.getPending()).toBeUndefined();
	expect(second.getPending()).toBeUndefined();
});

test('a failed held save prevents the whole scope while successful held saves remain landed', async () => {
	const { folder, edit, load, stored } = await setup();
	await load();
	expectOk(await folder.files.write('bad.md', null, 'original'));
	const bad = folder.files.edit('bad.md');
	expectOk(await bad.read());
	expectOk(edit.change({ fields: { title: 'Landed before refusal' } }));
	expectOk(bad.replaceText('cannot\0save'));
	let ran = false;
	expect(
		expectErr(
			await folder.run([MILK, bad.path], async () => {
				ran = true;
			}),
		).name,
	).toBe('NotStarted');
	expect(ran).toBe(false);
	expect(await stored(MILK)).toContain('title: Landed before refusal');
	expect(edit.getPending()).toBeUndefined();
	expect(bad.getPending()).toMatchObject({
		text: 'cannot\0save',
		error: { name: 'NotText' },
	});
	expect(edit.isLocked()).toBe(false);
	expect(bad.isLocked()).toBe(false);
});

test('throwing from a multi-file scope releases every path', async () => {
	const { folder, edit } = await setup();
	await expect(
		folder.run([MILK, 'audio/a.bin'], async () => {
			throw new Error('action failed');
		}),
	).rejects.toThrow('action failed');
	expect(edit.isLocked()).toBe(false);
	expect(folder.files.edit('audio/a.bin').isLocked()).toBe(false);
	expect(folder.getStatus().saving).toBe(false);
});

test('close reentered from reservation status waits for the complete multi-file scope', async () => {
	const { folder, edit, stored } = await setup();
	expectOk(await folder.files.write('remove.txt', null, 'remove me'));
	const audio = folder.files.edit('audio/a.bin');
	let closing: ReturnType<typeof folder.close> | undefined;
	cleanup.push(
		folder.onStatusChange((status) => {
			if (!status.saving || closing !== undefined) return;
			expect(edit.isLocked()).toBe(true);
			expect(audio.isLocked()).toBe(true);
			closing = folder.close();
		}),
	);
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const operation = folder.run(
		[MILK, audio.path, 'remove.txt'],
		async () => {
			entered.resolve();
			await gate.promise;
			const note = expectOk(await folder.files.read(MILK));
			expectOk(
				await folder.files.write(
					MILK,
					await note!.content.text(),
					'survives close',
				),
			);
			expectOk(
				await folder.files.write(audio.path, null, new Uint8Array([4, 5])),
			);
			expectOk(await folder.files.delete('remove.txt', 'remove me'));
		},
	);
	await entered.promise;
	expect(closing).toBeDefined();
	expect(folder.getStatus().closing).toBe(true);
	let finished = false;
	void closing!.then(() => {
		finished = true;
	});
	await Bun.sleep(0);
	expect(finished).toBe(false);
	gate.resolve();
	expectOk(await operation);
	expect(await closing).toEqual([]);
	expect(await stored(MILK)).toBe('survives close');
	expect(await stored('remove.txt')).toBeUndefined();
});

for (const closing of [false, true]) {
	test(`${closing ? 'close' : 'settle'} flushes unreserved input before an unrelated lifetime action finishes`, async () => {
		const { folder, edit, load, stored } = await setup();
		await load();
		expectOk(edit.change({ fields: { title: 'Save before network answers' } }));
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const saved = Promise.withResolvers<void>();
		cleanup.push(() => finish.resolve());
		const operation = folder.run([], async () => {
			entered.resolve();
			await finish.promise;
			// A captured input handle can finish its own save during close.
			// Joining the whole close here would wait for this callback itself.
			await edit.save();
			saved.resolve();
		});
		await entered.promise;
		let finished = false;
		const completion = (closing ? folder.close() : folder.settle()).then(
			(pending) => {
				finished = true;
				return pending;
			},
		);
		await until(() => edit.getPending() === undefined);
		expect(await stored(MILK)).toContain('title: Save before network answers');
		expect(folder.getStatus().saving).toBe(false);
		expect(finished).toBe(false);
		finish.resolve();
		await saved.promise;
		expectOk(await operation);
		expect(await completion).toEqual([]);
	});
}

for (const throws of [false, true]) {
	test(`a callback that ${throws ? 'throws' : 'returns'} keeps its paths reserved until a write it did not await finishes, and a failed write does not replace its outcome`, async () => {
		const { folder, engine, edit } = await setup();
		const started = Promise.withResolvers<void>();
		const fail = Promise.withResolvers<void>();
		cleanup.push(() => fail.resolve());
		engine.files.write = async () => {
			started.resolve();
			await fail.promise;
			throw new Error('storage broke');
		};
		let saving: Promise<unknown> | undefined;
		const operation = folder.run([MILK], async () => {
			// Not awaited: the reservation waits for it, not the callback.
			saving = folder.files.write(MILK, null, 'never stored').then(
				() => 'landed',
				(cause: unknown) => cause,
			);
			if (throws) throw new Error('callback failed');
			return 'callback returned';
		});
		let settled = false;
		const outcome = operation.then(
			(result) => {
				settled = true;
				return { result };
			},
			(cause: unknown) => {
				settled = true;
				return { cause };
			},
		);
		await started.promise;
		await Bun.sleep(0);
		expect(settled).toBe(false);
		expect(edit.isLocked()).toBe(true);
		expect(expectErr(await folder.run([MILK], async () => {})).name).toBe(
			'NotStarted',
		);
		let closed = false;
		const closing = folder.close().then(() => {
			closed = true;
		});
		await Bun.sleep(0);
		expect(closed).toBe(false);
		fail.resolve();
		expect(await saving).toMatchObject({ message: 'storage broke' });
		const finished = await outcome;
		if ('cause' in finished) {
			expect(throws).toBe(true);
			expect(finished.cause).toMatchObject({ message: 'callback failed' });
		} else {
			expect(throws).toBe(false);
			expect(expectOk(finished.result)).toBe('callback returned');
		}
		await closing;
		expect(closed).toBe(true);
	});
}

test('close never releases the engine under a write it accepted, at any turn around its last drain', async () => {
	let included = 0;
	let refused = 0;
	// Later and later writes, until one comes after the release.
	for (let turns = 0; refused === 0 && turns < 200; turns++) {
		const { folder, engine } = await setup();
		let writing = 0;
		let released = false;
		const violations: string[] = [];
		const write = engine.files.write;
		engine.files.write = async (...args) => {
			if (released) violations.push(`write called after release (${turns})`);
			writing++;
			try {
				return await write(...args);
			} finally {
				writing--;
			}
		};
		const close = engine.close;
		engine.close = () => {
			if (writing > 0) violations.push(`released under a write (${turns})`);
			released = true;
			close();
		};
		let late: Promise<unknown> | undefined;
		let closing: Promise<unknown> | undefined;
		expectOk(
			await folder.run([], async () => {
				// A continuation the action leaves running writes `turns` turns
				// after it ends, while close drains what it waits for.
				let chain = Promise.resolve();
				for (let turn = 0; turn < turns; turn++) chain = chain.then(() => {});
				late = chain.then(() => {
					try {
						return folder.files.write('late.txt', null, 'late');
					} catch (cause) {
						return cause;
					}
				});
				closing = folder.close();
			}),
		);
		await closing;
		const answer = await late;
		if (answer instanceof Error) {
			expect(answer.message).toBe('The folder is closed');
			refused++;
		} else {
			expectOk(answer as Awaited<ReturnType<typeof folder.files.write>>);
			included++;
		}
		expect(violations).toEqual([]);
	}
	// The sweep crossed the boundary: early writes were drained, a late one refused.
	expect(included).toBeGreaterThan(0);
	expect(refused).toBe(1);
});

test('a reservation waits for raw saves already queued on its paths before entering', async () => {
	const { folder, engine, stored } = await setup();
	const writes = intercept(engine.files, 'write');
	const started = writes.next();
	writes.hold();
	const first = folder.files.write(MILK, null, 'first raw save');
	const second = folder.files.write(MILK, 'first raw save', 'queued raw save');
	await started;
	let entered = false;
	const operation = folder.run([MILK], async () => {
		entered = true;
		const file = expectOk(await folder.files.read(MILK));
		expect(await file!.content.text()).toBe('queued raw save');
	});
	await Bun.sleep(0);
	expect(entered).toBe(false);
	expect(writes.calls).toHaveLength(1);
	writes.release();
	expectOk(await first);
	expectOk(await second);
	expectOk(await operation);
	expect(await stored(MILK)).toContain('queued raw save');
});

test('close with no view sends a running save, answers a failed one, and fences input', async () => {
	const { folder } = await setup();
	const bread = 'notes/bread.md';
	expectOk(await folder.files.write(bread, null, 'Rye'));
	const text = folder.files.edit(bread);
	await text.read();
	text.replaceText('Sourdough');
	const milk = folder.tables.notes.edit('milk');
	await milk.read();
	milk.change({ body: 'Oat, two litres' });
	const restore = fillDisk();
	const running = milk.save();
	expect(milk.getPending()?.saving).toBe(true);

	const closing = folder.close();
	expect(folder.getStatus().closing).toBe(true);
	expect(expectErr(text.replaceText('Too late'))).toMatchObject({
		name: 'Locked',
		reason: CLOSING,
	});
	await running;
	const unsaved = await closing;
	restore();

	expect(unsaved.map(({ path }) => path)).toEqual([bread, MILK]);
	expect(unsaved[0]?.text).toBe('Sourdough');
	expect(unsaved[1]?.text).toContain('Oat, two litres');
	expect(
		unsaved.every((pending) => pending.error?.name === 'StorageFailed'),
	).toBe(true);
	expect(folder.close()).toBe(closing);
	// What did not save stays readable after the engine is released.
	expect(folder.getStatus().failures).toEqual(unsaved);
	expect(text.getPending()).toBe(unsaved[0] as never);
	expect(milk.getPending()).toBe(unsaved[1] as never);
	expect(milk.getMarkdown()?.body).toBe('Oat, two litres');
});

for (const retry of ['lands', 'fails'] as const)
	test(`save() tries input that failed during close again while a late write keeps close waiting, and close answers what is held at release (retry ${retry})`, async () => {
		let accepted = 0;
		let refused = false;
		// The late write starts later and later after the failed attempt,
		// across the end of close's own sending, until it comes after release.
		for (let turns = 0; !refused && turns < 200; turns++) {
			const { folder, engine, stored } = await setup();
			const path = 'held.txt';
			expectOk(await folder.files.write(path, null, 'before'));
			const edit = folder.files.edit(path);
			expectOk(await edit.read());
			expectOk(edit.replaceText('after'));
			let attempts = 0;
			let failing = true;
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			cleanup.push(() => gate.resolve());
			const write = engine.files.write;
			engine.files.write = async (...args) => {
				// Hold only the edited file; the separate late write keeps close draining.
				if (args[0] === path) {
					attempts++;
					if (failing)
						return SaveError.StorageFailed({ cause: new Error('disk full') });
				} else if (args[0] === 'late.txt') {
					entered.resolve();
					await gate.promise;
				}
				return write(...args);
			};
			type Late =
				| { readonly accepted: ReturnType<typeof folder.files.write> }
				| { readonly refused: unknown };
			const late = Promise.withResolvers<Late>();
			let scheduled = false;
			cleanup.push(
				edit.subscribe(() => {
					if (scheduled || edit.getPending()?.error === undefined) return;
					scheduled = true;
					let chain = Promise.resolve();
					for (let turn = 0; turn < turns; turn++) chain = chain.then(() => {});
					late.resolve(
						chain.then((): Late => {
							try {
								return { accepted: folder.files.write('late.txt', null, 'late') };
							} catch (cause) {
								return { refused: cause };
							}
						}),
					);
				}),
			);

			const closing = folder.close();
			const outcome = await late.promise;
			if ('refused' in outcome) {
				// Released before the late write: close answered the failure, and
				// save() no longer attempts it.
				refused = true;
				expect(outcome.refused).toMatchObject({ message: 'The folder is closed' });
				expect(await closing).toMatchObject([
					{ path, text: 'after', error: { name: 'StorageFailed' } },
				]);
				await edit.save();
				expect(attempts).toBe(1);
				expect(edit.getPending()).toMatchObject({
					text: 'after',
					error: { name: 'StorageFailed' },
				});
				continue;
			}
			accepted++;
			await entered.promise;
			expect(attempts).toBe(1);
			// Close is waiting on the late write, so save() still attempts.
			failing = retry === 'fails';
			await edit.save();
			expect(attempts).toBe(2);
			let closed = false;
			void closing.then(() => {
				closed = true;
			});
			await Bun.sleep(0);
			expect(closed).toBe(false);
			gate.resolve();
			expectOk(await outcome.accepted);
			const unsaved = await closing;
			if (retry === 'lands') {
				expect(unsaved).toEqual([]);
				expect(edit.getPending()).toBeUndefined();
				expect(folder.getStatus().failures).toEqual([]);
				expect(await stored(path)).toBe('after');
			} else {
				expect(unsaved).toMatchObject([
					{ path, text: 'after', error: { name: 'StorageFailed' } },
				]);
				expect(unsaved[0]).toBe(edit.getPending() as never);
			}
		}
		expect(accepted).toBeGreaterThan(0);
		expect(refused).toBe(true);
	});

test('a status listener that writes while close drains is waited for, and refused once storage is released', async () => {
	const { folder, engine, edit, load } = await setup();
	await load();
	const writes = intercept(engine.files, 'write');
	let closes = 0;
	const close = engine.close;
	engine.close = () => {
		closes++;
		close();
	};
	const landing: Promise<unknown>[] = [];
	const refused: unknown[] = [];
	let started = false;
	folder.onStatusChange((status) => {
		if (!status.saving || started) return;
		started = true;
		try {
			landing.push(folder.files.write('reentrant.md', null, 'late'));
		} catch (cause) {
			refused.push(cause);
		}
	});
	edit.change({ fields: { title: 'Oat milk' } });

	await folder.close();

	expect(landing).toHaveLength(1);
	expectOk((await landing[0]) as Awaited<ReturnType<typeof folder.files.write>>);
	expect(writes.calls.map(([path]) => path)).toContain('reentrant.md');
	expect(refused).toEqual([]);
	expect(closes).toBe(1);
	expect(() => folder.files.write('after.md', null, 'late')).toThrow(
		'The folder is closed',
	);
	const reopened = await open();
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields?.title).toBe(
		'Oat milk',
	);
	const kept = expectOk(await reopened.files.read('reentrant.md'));
	expect(await kept?.content.text()).toBe('late');
});

test('an edit listener at the close fence is refused input, closes to the same promise, and its write is waited for', async () => {
	const { folder, engine, edit, load } = await setup();
	await load();
	edit.change({ fields: { title: 'Oat milk' } });
	let closes = 0;
	const close = engine.close;
	engine.close = () => {
		closes++;
		close();
	};
	let taken: boolean | undefined;
	let inner: Promise<unknown> | undefined;
	let written: ReturnType<typeof folder.files.write> | undefined;
	cleanup.push(
		edit.subscribe(() => {
			if (!edit.isLocked() || inner !== undefined) return;
			written = folder.files.write('fence-reentrant.md', null, 'late');
			taken = edit.change({ fields: { title: 'Too late' } }).error === null;
			inner = folder.close();
		}),
	);

	const outer = folder.close();
	expect(inner).toBe(outer);
	expect(taken).toBe(false);
	await outer;

	expectOk(await written!);
	expect(closes).toBe(1);
	const reopened = await open();
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields?.title).toBe(
		'Oat milk',
	);
	const kept = expectOk(await reopened.files.read('fence-reentrant.md'));
	expect(await kept?.content.text()).toBe('late');
});

test('closing the folder while a delete runs refuses new actions and lets the delete finish', async () => {
	const { folder, engine, edit } = await setup();
	const gets = intercept(engine.files, 'read');
	const started = gets.next();
	gets.hold();
	const deleting = edit.delete();
	await started;

	const closing = folder.close();
	expect(expectErr(await folder.run([], async () => {})).name).toBe(
		'NotStarted',
	);
	gets.release();
	expect(expectOk(await deleting)).toEqual({ deleted: true });
	expect(await closing).toEqual([]);

	const reopened = await open();
	expect(expectOk(await reopened.tables.notes.get('milk'))).toBeUndefined();
});

test('close waits for saves, never for a read that does not answer', async () => {
	const { folder, engine, edit, load } = await setup();
	await load();
	edit.change({ fields: { title: 'Oat' } });
	await edit.save();
	engine.tables.notes.list = () => new Promise(() => {});
	void folder.tables.notes.list();
	const read = engine.files.read;
	let waiting = true;
	engine.files.read = (path) => {
		if (!waiting) return read(path);
		waiting = false;
		return new Promise(() => {});
	};
	void edit.read();
	edit.change({ fields: { title: 'Oat milk' } });

	expect(await folder.close()).toEqual([]);
	const reopened = await open();
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields?.title).toBe(
		'Oat milk',
	);
});

// ============================================================================
// The folder owns its input from construction
// ============================================================================

test('plain code opens, reads, edits with no view or subscriber, sees status, settles and closes', async () => {
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

		const edit = folder.tables.notes.edit('milk');
		expectOk(await edit.read());
		if (edit.getMarkdown() === undefined) throw new Error('No document');
		expectOk(edit.change({ fields: { title: 'Oat' } }));
		expect(folder.getStatus().unsaved).toEqual([MILK]);
		expect(statuses.at(-1)?.unsaved).toEqual([MILK]);
		// The pause the folder was opened with saves it.
		await until(() => folder.getStatus().unsaved.length === 0);
		expect(expectOk(await folder.tables.notes.get('milk'))?.fields?.title).toBe(
			'Oat',
		);

		edit.change({ fields: { title: 'Oat milk' } });
		expect(await folder.settle()).toEqual([]);
		expect(edit.getMarkdown()?.fields?.title).toBe('Oat milk');
		expect(folder.getStatus()).toMatchObject({
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
	const { folder, engine, edit, load } = await setup();
	await load();
	const sets = intercept(engine.files, 'write');
	const unsaved: (readonly string[])[] = [];
	folder.onStatusChange((status) => unsaved.push(status.unsaved));
	edit.change({ fields: { title: 'Oat' } });
	edit.discard();
	expect(unsaved).toEqual([[MILK], []]);
	expect(sets.calls).toEqual([]);
});

// ============================================================================
// One save contract for every input kind
// ============================================================================

/** The edit of `milk` as `kind`, and a change of its title that way. */
async function inputOf(
	kind: 'document' | 'text' | 'generic',
	folder: Awaited<ReturnType<typeof setup>>['folder'],
) {
	const edit = folder.tables.notes.edit('milk');
	const text = folder.files.edit(MILK);
	await edit.read();
	const source = text.getText() ?? '';
	const input = kind === 'document' ? edit : text;
	const change = (title: string) => {
		if (kind === 'document') return edit.change({ fields: { title } });
		if (kind === 'text') return text.replaceText(source.replace('Milk', title));
		return text.change({ fields: { title } });
	};
	return { edit, text, input, change };
}

for (const kind of ['document', 'text', 'generic'] as const) {
	test(`${kind}: save attempts failed input again, and close saves it after recovery`, async () => {
		const { folder, engine, stored } = await setup();
		const { input, change } = await inputOf(kind, folder);
		const rows = intercept(engine.tables.notes, 'set');
		const files = intercept(engine.files, 'write');
		const submitted = () => rows.calls.length + files.calls.length;
		const restore = fillDisk();
		expectOk(change('Failed'));
		await input.save();
		expect(input.getPending()?.error?.name).toBe('StorageFailed');
		expect(submitted()).toBe(1);

		await input.save();
		expect(submitted()).toBe(2);
		expect(input.getPending()?.error?.name).toBe('StorageFailed');
		restore();
		await input.save();
		expect(submitted()).toBe(3);
		expect(input.getPending()).toBeUndefined();
		expect(await stored(MILK)).toContain('Failed');

		const restoreAgain = fillDisk();
		expectOk(change('Held for recovery'));
		await input.save();
		expect(submitted()).toBe(4);
		restoreAgain();
		expect(await folder.close()).toEqual([]);
		expect(submitted()).toBe(5);
		expect(input.getPending()).toBeUndefined();
		expect(await stored(MILK)).toContain('Held for recovery');
	});

	test(`${kind}: new input clears failure and resumes autosave`, async () => {
		const { folder, stored } = await setup('Two litres\n', 5);
		const { input, change } = await inputOf(kind, folder);
		const restore = fillDisk();
		expectOk(change('Failed'));
		await input.save();
		expect(input.getPending()?.error?.name).toBe('StorageFailed');
		restore();
		expectOk(change('New input'));
		expect(input.getPending()?.error).toBeUndefined();
		await until(() => input.getPending() === undefined);
		expect(await stored(MILK)).toContain('New input');
	});

	test(`${kind}: save during failure publication joins the finishing attempt`, async () => {
		const { folder, engine } = await setup();
		const { input, change } = await inputOf(kind, folder);
		const rows = intercept(engine.tables.notes, 'set');
		const files = intercept(engine.files, 'write');
		const restore = fillDisk();
		change('Failed');
		let asked = false;
		let joined: Promise<void> | undefined;
		const whileRunning = Promise.withResolvers<boolean>();
		const stop = input.subscribe(() => {
			if (asked || input.getPending()?.error === undefined) return;
			asked = true;
			let finished = false;
			joined = input.save().then(() => {
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
		expect(input.getPending()?.error?.name).toBe('StorageFailed');
	});
}

test('fields typed into failed whole text authorize the newer input', async () => {
	const { folder, stored } = await setup('Two litres\n', 5);
	const text = folder.files.edit(MILK);
	expectOk(await text.read());
	const source = text.getText() ?? '';
	const restore = fillDisk();
	text.replaceText(source.replace('Milk', 'Failed'));
	await text.save();
	restore();
	expect(text.getPending()?.error?.name).toBe('StorageFailed');
	expectOk(text.change({ fields: { title: 'New field' } }));
	expect(text.getPending()?.error).toBeUndefined();
	await until(() => text.getPending() === undefined);
	expect(await stored(MILK)).toContain('New field');
});

for (const action of ['save', 'discard', 'close'] as const) {
	test(`a new save owns the input before a listener calls ${action}`, async () => {
		const { folder, engine, edit, load, stored } = await setup();
		await load();
		const sets = intercept(engine.files, 'write');
		const restore = fillDisk();
		edit.change({ fields: { title: 'Retried' } });
		await edit.save();
		restore();
		let acted = false;
		let work: Promise<unknown> | undefined;
		const stop = edit.subscribe(() => {
			const pending = edit.getPending();
			if (acted || pending?.error !== undefined || pending === undefined)
				return;
			acted = true;
			if (action === 'discard') expect(edit.discard()).toBeUndefined();
			else if (action === 'close') work = folder.close();
			else work = edit.save();
		});
		cleanup.push(stop);
		await edit.save();
		await work;
		expect(acted).toBe(true);
		expect(sets.calls).toHaveLength(2);
		expect(edit.getPending()).toBeUndefined();
		expect(await stored(MILK)).toContain('Retried');
	});
}

for (const kind of ['document', 'text', 'generic'] as const) {
	for (const request of ['save', 'close'] as const) {
		test(`${kind}: new input requested during failure publication is not stranded by ${request}`, async () => {
			const { folder, engine, stored } = await setup();
			const { input, change } = await inputOf(kind, folder);
			const rows = intercept(engine.tables.notes, 'set');
			const files = intercept(engine.files, 'write');
			const restore = fillDisk();
			let changed = false;
			let joined: Promise<unknown> | undefined;
			const stop = input.subscribe(() => {
				if (changed || input.getPending()?.error === undefined) return;
				changed = true;
				restore();
				expectOk(change('New input'));
				joined = request === 'close' ? folder.close() : input.save();
			});
			cleanup.push(stop);
			change('Failed');
			await input.save();
			await joined;
			expect(changed).toBe(true);
			expect(input.getPending()).toBeUndefined();
			expect(rows.calls.length + files.calls.length).toBe(2);
			expect(await stored(MILK)).toContain('New input');
		});
	}
}

for (const kind of ['document', 'text', 'generic'] as const) {
	test(`${kind}: close drains input accepted while a successful save clears`, async () => {
		const { folder, engine, stored } = await setup();
		const { input, change } = await inputOf(kind, folder);
		const rows = intercept(engine.tables.notes, 'set');
		const files = intercept(engine.files, 'write');
		let changed = false;
		let closing: Promise<unknown> | undefined;
		change('First');
		const stop = input.subscribe(() => {
			if (changed || input.getPending() !== undefined) return;
			changed = true;
			expectOk(change('New input'));
			closing = folder.close();
		});
		cleanup.push(stop);
		await input.save();
		await closing;
		expect(changed).toBe(true);
		expect(input.getPending()).toBeUndefined();
		expect(rows.calls.length + files.calls.length).toBe(2);
		expect(await stored(MILK)).toContain('New input');
	});
}

for (const outcome of ['success', 'failure'] as const) {
	for (const request of ['microtask save', 'settle'] as const) {
		test(`${outcome}: ${request} cannot join a drain that already stopped`, async () => {
			const { folder, engine, edit, load, stored } = await setup();
			await load();
			const sets = intercept(engine.files, 'write');
			const restore = outcome === 'failure' ? fillDisk() : () => {};
			edit.change({ fields: { title: 'First' } });
			let asked = false;
			const requested = Promise.withResolvers<unknown>();
			const stop = edit.subscribe(() => {
				if (asked) return;
				const pending = edit.getPending();
				if (
					outcome === 'success'
						? pending !== undefined
						: pending?.error === undefined
				)
					return;
				asked = true;
				const next = () => {
					restore();
					edit.change({ fields: { title: 'New input' } });
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
			expect(edit.getPending()).toBeUndefined();
			expect(sets.calls).toHaveLength(2);
			expect(await stored(MILK)).toContain('New input');
		});
	}
}

test('file reads seed one source for generic and schema-bound table interpretations', async () => {
	const { folder, engine } = await setup();
	const path = 'notes/plain.md';
	expectOk(await folder.files.write(path, null, 'Plain body\n'));
	const reads = intercept(engine.files, 'read');
	expectOk(await folder.files.read(path));
	const generic = folder.files.edit(path);
	const checked = folder.files.edit(path, notes);
	const table = folder.tables.notes.edit('plain');
	expect(generic.getMarkdown()).toEqual({
		text: 'Plain body\n',
		body: 'Plain body\n',
		fields: {},
		issues: null,
	});
	expect(
		checked.getMarkdown()?.issues?.every((issue) => issue.kind === 'schema'),
	).toBe(true);
	expect(table.getMarkdown()?.issues?.[0]?.kind).toBe('schema');
	expect(table.getMarkdown()?.fields).toEqual({});
	expect(table.getMarkdown()?.body).toBe('Plain body\n');
	expect(generic.getMarkdown()).toBe(folder.files.edit(path).getMarkdown());
	expect(checked.getMarkdown()).toBe(
		folder.files.edit(path, notes).getMarkdown(),
	);
	expect(table.getMarkdown()).toBe(
		folder.tables.notes.edit('plain').getMarkdown(),
	);
	expectOk(generic.change({ fields: { title: 'Now framed', done: true } }));
	expect(table.getMarkdown()?.issues).toBeNull();
	expect(table.getMarkdown()?.text).toBe(generic.getText());
	expect(Object.keys(table.getMarkdown()!).sort()).toEqual([
		'body',
		'fields',
		'issues',
		'text',
	]);
	expect(reads.calls).toHaveLength(1);
});

test('a throwing read schema leaves exact Markdown and raw fields available', async () => {
	const { folder } = await setup();
	const source = '---\ntitle: value\n---\nbody\n';
	expectOk(await folder.files.write('notes/a.md', null, source));
	const schema = Type.Object({
		title: Type.Refine(Type.String(), () => {
			throw new Error('validator failed');
		}),
	});
	const edit = folder.files.edit('notes/a.md', schema);
	expectOk(await edit.read());
	expect(edit.getMarkdown()).toMatchObject({
		text: source,
		body: 'body\n',
		fields: { title: 'value' },
	});
	expect(edit.getMarkdown()?.issues?.[0]?.message).toContain(
		'validator failed',
	);
});

test('table and file edits use the same body boundary for plain Markdown', async () => {
	const { folder } = await setup();
	const path = 'notes/plain.md';
	expectOk(await folder.files.write(path, null, 'Plain body\n'));
	const table = folder.tables.notes.edit('plain');
	const file = folder.files.edit(path);
	expectOk(await table.read());
	expectOk(table.change({ body: 'Changed\n' }));
	expectOk(file.change({ body: 'Changed\n' }));
	expect(file.getMarkdown()?.body).toBe('Changed\n');
	expect(table.getMarkdown()?.body).toBe('Changed\n');
	expect(table.getText()).toBe('Changed\n');
});

test('a structured save refuses a header broken after its source preparation', async () => {
	const { engine, edit, load, writeElsewhere, stored } = await setup();
	await load();
	expectOk(edit.change({ fields: { title: 'Held' } }));
	const writes = intercept(engine.files, 'write');
	const started = writes.next();
	writes.hold();
	const saving = edit.save();
	await started;
	const broken = '---\ntitle: [broken\n---\nOutside body\n';
	await writeElsewhere(MILK, (await stored(MILK)) ?? null, broken);
	writes.release();
	await saving;
	expect(edit.getPending()?.text).toContain('title: Held');
	expect(edit.getPending()?.error?.name).toBe('Conflict');
	expect(await stored(MILK)).toBe(broken);
	expect(edit.getMarkdown()?.text).toBe(edit.getText());
	expect(edit.getMarkdown()?.fields).toEqual({ done: false, title: 'Held' });
});

test('Markdown snapshot identity follows editable text through save start and failure', async () => {
	const { folder, engine, edit, load } = await setup();
	await load();
	expectOk(edit.change({ fields: { title: 'Held' } }));
	const shown = edit.getMarkdown();
	const file = folder.files.edit(MILK, notes);
	const genericShown = file.getMarkdown();
	const writes = intercept(engine.files, 'write');
	const started = writes.next();
	writes.hold();
	const restore = fillDisk();
	const saving = edit.save();
	expect(edit.getPending()?.saving).toBe(true);
	expect(edit.getMarkdown()).toBe(shown);
	expect(file.getMarkdown()).toBe(genericShown);
	await started;
	writes.release();
	await saving;
	expect(edit.getPending()?.error?.name).toBe('StorageFailed');
	expect(edit.getMarkdown()).toBe(shown);
	expect(file.getMarkdown()).toBe(genericShown);
	expectOk(edit.change({ fields: { title: 'Changed' } }));
	expect(edit.getMarkdown()).not.toBe(shown);
	expect(edit.getMarkdown()?.fields?.title).toBe('Changed');
	expect(file.getMarkdown()).not.toBe(genericShown);
	restore();
});
