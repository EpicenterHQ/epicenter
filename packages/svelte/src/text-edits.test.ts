/**
 * Whole-file edits over real Folder storage on an in-memory IndexedDB.
 * Verifies exact source, in-flight typing and merge bases, representation
 * exclusion, deletion fencing, query refresh, and close recovery. A held
 * storage call exposes races; storage refusals come from IndexedDB itself.
 */
import './svelte-modules.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { QueryObserver } from '@tanstack/query-core';
import { defineFileRead } from './folder-queries.js';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';

const { createFolderContext } = await import('./folder-context.js');
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});
const path = 'notes/a.md';
const initial = '---\ntitle: A\n---\none\n\ntwo\n';

async function setup(source = initial, saveAfterMs = 60_000) {
	globalThis.indexedDB = new IDBFactory();
	const tables = { notes: Type.Object({ title: Type.String() }) };
	const folder = expectOk(await openFolder({ tables }));
	expectOk(await folder.files.write(path, null, source));
	const context = createFolderContext(folder, { saveAfterMs });
	cleanup.push(() => context.close());
	const reader = defineFileRead('text', async (files, path) => {
		const file = expectOk(await files.read(path));
		return file === undefined ? null : await file.content.text();
	});
	const query = new QueryObserver(context.queryClient, context.queries.file(path, reader));
	cleanup.push(query.subscribe(() => {}));
	await context.queryClient.fetchQuery(context.queries.rows('notes'));
	const other = expectOk(await openFolder({ tables }));
	cleanup.push(() => other.close());
	return {
		folder,
		context,
		other,
		query,
		text: context.edits.text(path),
	};
}

async function sourceOf(folder: Awaited<ReturnType<typeof setup>>['folder']) {
	const file = expectOk(await folder.files.read(path));
	return file?.content.text();
}

test('newer typing starts from the exact submitted text and preserves another writer’s change', async () => {
	const { folder, context, other, text, query } = await setup();
	const write = folder.files.write;
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	folder.files.write = async (...args) => {
		started.resolve();
		await gate.promise;
		return write(...args);
	};
	cleanup.push(() => {
		folder.files.write = write;
		gate.resolve();
	});
	text.change(initial, initial.replace('title: A', 'title: Mine'));
	const first = text.save();
	await started.promise;
	const next = initial
		.replace('title: A', 'title: Mine')
		.replace('one\n', 'one!\n');
	text.change(initial, next);
	const second = text.save();
	expectOk(
		await other.files.write(path, initial, initial.replace('two\n', 'two?\n')),
	);
	gate.resolve();
	await Promise.all([first, second]);
	expect(await sourceOf(other)).toBe(next.replace('two\n', 'two?\n'));
	expect(query.getCurrentResult().data).toBe(next.replace('two\n', 'two?\n'));
	expect(text.held).toBe(false);
	expect(context.saveState).toBe('saved');
});

test('a failed text save prevents a competing row edit until explicit discard', async () => {
	const { context, text } = await setup();
	const row = expectOk(await context.folder.tables.notes.get('a'));
	if (row === undefined) throw new Error('The note must be cached');
	const put = IDBObjectStore.prototype.put;
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Full', 'QuotaExceededError');
	};
	text.change(initial, 'unfinished source');
	await text.save();
	expect(context.saveState).toBe('failed');
	expect(context.edits.textFailures[0]?.text).toBe('unfinished source');
	const editor = context.edits.row('notes', 'a');
	expect(editor.change(row, { body: 'Do not overwrite the source' })).toBe(
		false,
	);
	expect(text.discard()?.text).toBe('unfinished source');
	IDBObjectStore.prototype.put = put;
	expect(editor.change(row, { body: 'A body edit' })).toBe(true);
	expect(text.change(initial, 'Do not overwrite the body')).toBe(false);
	await editor.save();
	expect(text.change(initial, 'new source')).toBe(true);
});

test('whole-file saving keeps BOM, CRLF, and the last newline exactly as submitted', async () => {
	const original = '\uFEFF---\r\ntitle: A\r\n---\r\nbody\r\n';
	const { folder, text, other } = await setup(original);
	const file = expectOk(await folder.files.read(path));
	if (file === undefined) throw new Error('The note must exist');
	const bytes = new Uint8Array(await file.content.arrayBuffer());
	const changed = original.replace('body', 'changed');
	text.change(bytes, changed);
	bytes.fill(0); // The owner captured its source before accepting the input.
	await text.save();
	const saved = expectOk(await other.files.read(path));
	if (saved === undefined) throw new Error('The saved note must exist');
	expect(new Uint8Array(await saved.content.arrayBuffer())).toEqual(
		new TextEncoder().encode(changed),
	);
});

test('deletion fences text immediately and drains its save before removing the row', async () => {
	const { folder, context, text, other } = await setup();
	const write = folder.files.write;
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	folder.files.write = async (...args) => {
		started.resolve();
		await gate.promise;
		return write(...args);
	};
	cleanup.push(() => {
		folder.files.write = write;
		gate.resolve();
	});
	text.change(initial, initial.replace('one', 'typed'));
	const saving = text.save();
	await started.promise;
	const deleting = context.edits.delete('notes', 'a');
	expect(text.locked).toBe(true);
	expect(text.change(initial, 'late text')).toBe(false);
	const leaving = text.save();
	gate.resolve();
	await Promise.all([saving, leaving]);
	expect(expectOk(await deleting).deleted).toBe(true);
	expect(await sourceOf(other)).toBeUndefined();
	expect(text.held).toBe(false);
});

test('failed whole-file input refuses deletion and close returns its exact text', async () => {
	const { context, text } = await setup();
	const put = IDBObjectStore.prototype.put;
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Full', 'QuotaExceededError');
	};
	const changed = '---\nbroken: [\nkeep this\r\n';
	text.change(initial, changed);
	expect(expectErr(await context.edits.deleteFile(path)).name).toBe(
		'NotStarted',
	);
	expect(text.text).toBe(changed);
	const closing = context.close();
	expect(text.change(initial, 'late')).toBe(false);
	expect(await closing).toMatchObject([
		{ path, unsaved: changed, error: { name: 'StorageFailed' } },
	]);
});

test('settling a table saves its whole-file edits and refreshes the rows before release', async () => {
	const { context, text } = await setup();
	const rows = new QueryObserver(
		context.queryClient,
		context.queries.rows('notes'),
	);
	cleanup.push(rows.subscribe(() => {}));
	text.change(initial, initial.replace('title: A', 'title: Repaired'));
	expect(await context.edits.settled('notes')).toEqual([]);
	expect(text.held).toBe(false);
	expect(rows.getCurrentResult().data?.[0]?.fields.title).toBe('Repaired');
});

test('deleteFile keeps a file another writer changed after the deletion read it', async () => {
	const { folder, context, other } = await setup();
	const remove = folder.files.delete;
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	folder.files.delete = async (...args) => {
		started.resolve();
		await gate.promise;
		return remove(...args);
	};
	cleanup.push(() => {
		folder.files.delete = remove;
		gate.resolve();
	});
	const deleting = context.edits.deleteFile(path);
	await started.promise;
	const changed = initial.replace('one', 'another writer');
	expectOk(await other.files.write(path, initial, changed));
	gate.resolve();
	expect(expectOk(await deleting).deleted).toBe(false);
	expect(await sourceOf(other)).toBe(changed);
});

test('a refused delete leaves failed text held until typing or explicit retry', async () => {
	const { folder, context, text, other } = await setup(initial, 10);
	const put = IDBObjectStore.prototype.put;
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Full', 'QuotaExceededError');
	};
	text.change(initial, 'Keep this failed text');
	expectErr(await context.edits.deleteFile(path));
	IDBObjectStore.prototype.put = put;
	let writes = 0;
	const write = folder.files.write;
	folder.files.write = async (...args) => {
		writes++;
		return write(...args);
	};
	cleanup.push(() => {
		folder.files.write = write;
	});
	await Bun.sleep(50);
	expect(writes).toBe(0);
	expect(text.held).toBe(true);
	expect(await sourceOf(other)).toBe(initial);
	await text.save();
	expect(await sourceOf(other)).toBe('Keep this failed text');
});
