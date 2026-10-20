/**
 * Whole-file edits (`folder.files.edit(path)`) over real Folder storage on an
 * in-memory IndexedDB, with a folder context rereading after each save.
 * Verifies exact source, typing during a save, representation exclusion,
 * deletion fencing, query refresh, close recovery, and the Svelte binding
 * `createTextEdit`. Storage refusals come from IndexedDB itself.
 */
import './svelte-modules.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { fileBytes } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { QueryObserver } from '@tanstack/query-core';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFileRead } from './folder-queries.js';

const { createFolderContext } = await import('./folder-context.js');
const { createTextEdit } = await import('./edits.js');
const { cell, follow } = await import('./reactive.test-support.svelte.js');
const { flushSync } = await import('svelte');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});
const path = 'notes/a.md';
const initial = '---\ntitle: A\n---\none\n\ntwo\n';
const decode = (bytes: Uint8Array) =>
	new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

/** The file's bytes, the source a view of it names. */
const sourceRead = defineFileRead('bytes', async (files, path) => {
	const file = expectOk(await files.read(path));
	return file === undefined ? null : await fileBytes(file.content);
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
	/** The bytes the view shows now. */
	const observed = () => {
		const data = query.getCurrentResult().data;
		if (data == null) throw new Error('The file is not cached');
		return data;
	};
	return {
		folder,
		context,
		other,
		query,
		observed,
		text: folder.files.edit(path),
	};
}

async function sourceOf(folder: Awaited<ReturnType<typeof setup>>['folder']) {
	const file = expectOk(await folder.files.read(path));
	return file === undefined ? undefined : decode(await fileBytes(file.content));
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
	const { context, other, text, observed, query } = await setup();
	const source = observed();
	text.change(source, initial.replace('title: A', 'title: Mine'));
	const first = text.save();
	const next = initial
		.replace('title: A', 'title: Mine')
		.replace('one\n', 'one!\n');
	text.change(undefined, next);
	const second = text.save();
	expectOk(
		await other.files.write(path, initial, initial.replace('two\n', 'two?\n')),
	);
	await Promise.all([first, second]);
	expect(await sourceOf(other)).toBe(next.replace('two\n', 'two?\n'));
	await until(
		() =>
			decode(query.getCurrentResult().data ?? new Uint8Array()) ===
			next.replace('two\n', 'two?\n'),
	);
	expect(text.pending).toBeUndefined();
	expect(context.saveState).toBe('saved');
});

test('a failed text save prevents a competing row edit until explicit discard', async () => {
	const { context, text, observed } = await setup();
	const row = expectOk(await context.folder.tables.notes.get('a'));
	if (row === undefined) throw new Error('The note must be cached');
	const restore = fillDisk();
	text.change(observed(), 'unfinished source');
	await text.save();
	expect(context.saveState).toBe('failed');
	expect(context.failures).toMatchObject([
		{ kind: 'text', path, text: 'unfinished source' },
	]);
	const edit = context.folder.tables.notes.edit('a');
	expect(edit.change(row, { body: 'Do not overwrite the source' })).toBe(false);
	expect(text.discard()).toMatchObject({ text: 'unfinished source' });
	restore();
	expect(edit.change(row, { body: 'A body edit' })).toBe(true);
	expect(text.change(observed(), 'Do not overwrite the body')).toBe(false);
	await edit.save();
	expect(text.change(observed(), 'new source')).toBe(true);
});

test('whole-file saving keeps BOM, CRLF, and the last newline exactly as submitted', async () => {
	const original = '﻿---\r\ntitle: A\r\n---\r\nbody\r\n';
	const { text, other, observed } = await setup(original);
	const bytes = observed().slice();
	const changed = original.replace('body', 'changed');
	text.change(bytes, changed);
	bytes.fill(0); // The owner captured its source before accepting the input.
	await text.save();
	const saved = expectOk(await other.files.read(path));
	if (saved === undefined) throw new Error('The saved note must exist');
	expect(await fileBytes(saved.content)).toEqual(
		new TextEncoder().encode(changed),
	);
});

test('deletion fences text immediately and sends its held text before removing the row', async () => {
	const { folder, text, other, observed } = await setup();
	text.change(observed(), initial.replace('one', 'typed'));
	const deleting = folder.tables.notes.edit('a').delete();
	expect(text.locked).toBe(true);
	expect(text.change(observed(), 'late text')).toBe(false);
	await text.save();
	expect(expectOk(await deleting).deleted).toBe(true);
	expect(await sourceOf(other)).toBeUndefined();
	expect(text.pending).toBeUndefined();
});

test('failed whole-file input refuses deletion and close returns its exact text', async () => {
	const { context, text, observed } = await setup();
	fillDisk();
	const changed = '---\nbroken: [\nkeep this\r\n';
	text.change(observed(), changed);
	expect(expectErr(await text.delete()).name).toBe('NotStarted');
	expect(text.pending).toMatchObject({ text: changed });
	const source = observed();
	expect(await context.close()).toMatchObject([
		{ path, unsaved: changed, error: { name: 'StorageFailed' } },
	]);
	expect(text.change(source, 'late')).toBe(false);
	expect(text.pending).toMatchObject({ text: changed });
});

test('settling saves whole-file edits, and the rows are read again after it', async () => {
	const { context, text, observed } = await setup();
	const rows = new QueryObserver(
		context.queryClient,
		context.queries.rows('notes'),
	);
	cleanup.push(rows.subscribe(() => {}));
	text.change(observed(), initial.replace('title: A', 'title: Repaired'));
	expect(await context.settled()).toBe(true);
	expect(text.pending).toBeUndefined();
	await until(
		() => rows.getCurrentResult().data?.[0]?.fields.title === 'Repaired',
	);
});

test('a refused delete leaves failed text held until typing or explicit retry', async () => {
	const { text, other, observed } = await setup(initial, 10);
	const restore = fillDisk();
	text.change(observed(), 'Keep this failed text');
	expectErr(await text.delete());
	restore();
	await Bun.sleep(50);
	expect(text.pending).toBeDefined();
	expect(await sourceOf(other)).toBe(initial);
	await text.retry();
	expect(await sourceOf(other)).toBe('Keep this failed text');
});

test('the text binding shows held text over the observed bytes, BOM kept, and its own saved text with nothing observed', async () => {
	const original = '﻿one\r\n';
	const { folder, other, observed } = await setup(original);
	const shownBytes = cell<Uint8Array | undefined>(observed());
	const view = createTextEdit(folder.files.edit(path), () => shownBytes.value);
	const shown = follow(() => view.text);
	cleanup.push(shown.stop);
	flushSync();

	expect(view.change('﻿one!\r\n')).toBe(true);
	flushSync();
	shownBytes.value = undefined;
	flushSync();
	expect(view.change('﻿one!!\r\n')).toBe(true);
	flushSync();
	await view.save();
	flushSync();

	const changes = shown.values.filter(
		(value, index) => index === 0 || value !== shown.values[index - 1],
	);
	expect(changes).toEqual(['﻿one\r\n', '﻿one!\r\n', '﻿one!!\r\n']);
	// With nothing observed there is no source to start new typing from.
	expect(view.change('﻿late\r\n')).toBe(false);
	const saved = expectOk(await other.files.read(path));
	expect(await fileBytes(saved!.content)).toEqual(
		new TextEncoder().encode('﻿one!!\r\n'),
	);
});

test('the text binding keeps a landed save shown when the reread fails, and typing over it keeps it', async () => {
	const { folder, other, query, observed } = await setup('one\n');
	const before = observed();
	const view = createTextEdit(folder.files.edit(path), () => before);
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
