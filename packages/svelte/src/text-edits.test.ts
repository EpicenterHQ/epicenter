/**
 * Whole-file edits (`folder.files.edit(path)`) over real Folder storage on an
 * in-memory IndexedDB, with a folder context rereading after each save.
 * Verifies exact source, typing during a save, shared row and text input,
 * deletion fencing, query refresh, close recovery, and the Svelte binding
 * `createTextEdit(folder.files, path)`. Storage refusals come from
 * IndexedDB itself.
 */
import './svelte-modules.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { QueryObserver } from '@tanstack/query-core';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFileRead } from './folder-queries.js';

const { createFolderContext } = await import('./folder-context.js');
const { createTextEdit } = await import('./edits.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync } = await import('svelte');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});
const path = 'notes/a.md';
const initial = '---\ntitle: A\n---\none\n\ntwo\n';
const decode = (bytes: Uint8Array) =>
	new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
const bytesOf = async (content: Blob) =>
	new Uint8Array(await content.arrayBuffer());

/** The file's text, a derived value a view of it lists. */
const sourceRead = defineFileRead('source', async (files, path) => {
	const file = expectOk(await files.read(path));
	return file === undefined ? null : decode(await bytesOf(file.content));
});

async function setup(source = initial, saveAfterMs = 60_000) {
	globalThis.indexedDB = new IDBFactory();
	const tables = { notes: Type.Object({ title: Type.String() }) };
	const folder = expectOk(await openFolder({ tables, saveAfterMs }));
	expectOk(await folder.files.write(path, null, source));
	const context = createFolderContext(folder);
	cleanup.push(() => context.close());
	const query = new QueryObserver(
		context.queryClient,
		context.queries.file(path, sourceRead),
	);
	cleanup.push(query.subscribe(() => {}));
	await until(() => query.getCurrentResult().data != null);
	const other = expectOk(await openFolder({ tables }));
	cleanup.push(() => other.close());
	const text = folder.files.edit(path);
	expectOk(await text.read());
	return { folder, context, other, query, text };
}

async function sourceOf(folder: Awaited<ReturnType<typeof setup>>['folder']) {
	const file = expectOk(await folder.files.read(path));
	return file === undefined ? undefined : decode(await bytesOf(file.content));
}

async function until(check: () => boolean) {
	for (let tries = 0; tries < 400; tries++) {
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error('Timed out waiting');
}

/** Make every IndexedDB write fail the way a full disk does. */
function fillDisk() {
	const put = IDBObjectStore.prototype.put;
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Full', 'QuotaExceededError');
	};
	return () => {
		IDBObjectStore.prototype.put = put;
	};
}

test('typing while a save runs starts from the exact submitted text and keeps another writer’s change', async () => {
	const { context, other, text, query } = await setup();
	// A view shows the file, so another writer's change is read for it.
	cleanup.push(text.subscribe(() => {}));
	text.change(initial.replace('title: A', 'title: Mine'));
	const first = text.save();
	const next = initial
		.replace('title: A', 'title: Mine')
		.replace('one\n', 'one!\n');
	text.change(next);
	const second = text.save();
	expectOk(
		await other.files.write(path, initial, initial.replace('two\n', 'two?\n')),
	);
	await Promise.all([first, second]);
	expect(await sourceOf(other)).toBe(next.replace('two\n', 'two?\n'));
	await until(
		() => query.getCurrentResult().data === next.replace('two\n', 'two?\n'),
	);
	expect(text.getPending()).toBeUndefined();
	expect(text.getText()).toBe(next.replace('two\n', 'two?\n'));
	expect(context.getSaveState()).toBe('saved');
});

test('failed text stays visible to the row view, whose next change preserves other text', async () => {
	const { context, text: textEdit } = await setup();
	const restore = fillDisk();
	expectOk(textEdit.change(initial.replace('one', 'unfinished source')));
	await textEdit.save();
	const rowEdit = context.folder.tables.notes.edit('a');
	expect(rowEdit.getPending()).toBe(textEdit.getPending());
	expect(rowEdit.getRow()?.body).toContain('unfinished source');
	expect(rowEdit.getPending()?.error?.name).toBe('StorageFailed');
	restore();
	expectOk(rowEdit.change({ fields: { title: 'A row change' } }));
	expect(textEdit.getText()).toContain('unfinished source');
	await rowEdit.save();
	expect(textEdit.getPending()).toBeUndefined();
	expect(textEdit.getText()).toContain('title: A row change');
});

test('whole-file saving keeps BOM, CRLF, and the last newline exactly as submitted', async () => {
	const original = '﻿---\r\ntitle: A\r\n---\r\nbody\r\n';
	const { text, other } = await setup(original);
	expect(text.getText()).toBe(original);
	const changed = original.replace('body', 'changed');
	text.change(changed);
	await text.save();
	const saved = expectOk(await other.files.read(path));
	if (saved === undefined) throw new Error('The saved note must exist');
	expect(await bytesOf(saved.content)).toEqual(
		new TextEncoder().encode(changed),
	);
});

test('deletion fences text immediately and sends its held text before removing the row', async () => {
	const { folder, text, other } = await setup();
	text.change(initial.replace('one', 'typed'));
	const deleting = folder.tables.notes.edit('a').delete();
	expect(text.isLocked()).toBe(true);
	expectErr(text.change('late text'));
	await text.save();
	expect(expectOk(await deleting).deleted).toBe(true);
	expect(await sourceOf(other)).toBeUndefined();
	expect(text.getPending()).toBeUndefined();
	expect(text.getText()).toBeUndefined();
});

test('failed whole-file input refuses deletion and close returns its exact text', async () => {
	const { context, text } = await setup();
	fillDisk();
	const changed = '---\nbroken: [\nkeep this\r\n';
	text.change(changed);
	expect(expectErr(await text.delete()).name).toBe('NotStarted');
	expect(text.getPending()).toMatchObject({ text: changed });
	expect(await context.close()).toMatchObject([
		{ path, unsaved: changed, error: { name: 'StorageFailed' } },
	]);
	expectErr(text.change('late'));
	expect(text.getPending()).toMatchObject({ text: changed });
});

test('settling saves whole-file edits, and the rows are read again after it', async () => {
	const { context, text } = await setup();
	const rows = new QueryObserver(
		context.queryClient,
		context.queries.rows('notes'),
	);
	cleanup.push(rows.subscribe(() => {}));
	text.change(initial.replace('title: A', 'title: Repaired'));
	expect(await context.folder.settle()).toEqual([]);
	expect(text.getPending()).toBeUndefined();
	await until(
		() => rows.getCurrentResult().data?.[0]?.fields.title === 'Repaired',
	);
});

test('a refused delete leaves failed text held until typing or explicit retry', async () => {
	const { text, other } = await setup(initial, 10);
	const restore = fillDisk();
	text.change('Keep this failed text');
	expectErr(await text.delete());
	restore();
	await Bun.sleep(50);
	expect(text.getPending()).toBeDefined();
	expect(await sourceOf(other)).toBe(initial);
	await text.retry();
	expect(await sourceOf(other)).toBe('Keep this failed text');
});

test('the text binding shows held text over the stored file, BOM kept, and the saved text after', async () => {
	const original = '﻿one\r\n';
	const { folder, other } = await setup(original);
	const view = createTextEdit(folder.files, path);
	const shown = follow(() => view.text);
	cleanup.push(shown.stop);
	flushSync();

	expectOk(view.change('﻿one!\r\n'));
	flushSync();
	expectOk(view.change('﻿one!!\r\n'));
	flushSync();
	await view.save();
	flushSync();

	const changes = shown.values.filter(
		(value, index) => index === 0 || value !== shown.values[index - 1],
	);
	expect(changes).toEqual(['﻿one\r\n', '﻿one!\r\n', '﻿one!!\r\n']);
	expect(view.pending).toBeUndefined();
	const saved = expectOk(await other.files.read(path));
	expect(await bytesOf(saved!.content)).toEqual(
		new TextEncoder().encode('﻿one!!\r\n'),
	);
});

test('the text binding reads a file the first time a view shows it, and a missing one shows nothing', async () => {
	const { folder } = await setup('one\n');
	expectOk(await folder.files.write('notes/b.md', null, 'b\n'));
	const view = createTextEdit(folder.files, 'notes/b.md');
	const ghost = createTextEdit(folder.files, 'notes/ghost.md');
	const shown = follow(
		() => [view.readStatus.known, view.text] as const,
	);
	const missing = follow(
		() => [ghost.readStatus.known, ghost.text] as const,
	);
	cleanup.push(shown.stop, missing.stop);
	flushSync();
	expect(shown.values[0]).toEqual(['nothing', undefined]);
	await until(
		() => view.text !== undefined && !ghost.readStatus.reading,
	);
	flushSync();
	expect(shown.values.at(-1)).toEqual(['file', 'b\n']);
	expect(missing.values.at(-1)).toEqual(['missing', undefined]);
	expect(ghost.readStatus.error).toBeUndefined();
	expect(expectErr(ghost.change('x')).name).toBe('NoSource');
});

test('the text binding shows a file that is not text as such, and refuses to type over it', async () => {
	const { folder } = await setup('one\n');
	const bytes = new Uint8Array([255, 254, 0]);
	expectOk(await folder.files.write('notes/raw.md', null, bytes));
	const view = createTextEdit(folder.files, 'notes/raw.md');
	const known = follow(() => view.readStatus.known);
	cleanup.push(known.stop);
	flushSync();
	await until(() => view.readStatus.known !== 'nothing');
	flushSync();
	expect(known.values.at(-1)).toBe('not-text');
	expect(view.text).toBeUndefined();
	expect(expectErr(view.change('x')).name).toBe('NotText');
	const stored = expectOk(await folder.files.read('notes/raw.md'));
	expect(await bytesOf(stored!.content)).toEqual(bytes);
});

test('the text binding keeps a landed save shown when the reread fails, and typing over it keeps it', async () => {
	const { folder, other, query } = await setup('one\n');
	const view = createTextEdit(folder.files, path);
	const read = folder.files.read;
	folder.files.read = async () => {
		throw new Error('Read failed');
	};
	cleanup.push(() => {
		folder.files.read = read;
	});
	view.change('one\nmine\n');
	await view.save();
	await until(() => query.getCurrentResult().isError);
	expect(view.pending).toBeUndefined();
	expect(view.text).toBe('one\nmine\n');
	view.change(`${view.text}more\n`);
	await view.save();
	expect(await sourceOf(other)).toBe('one\nmine\nmore\n');
});
