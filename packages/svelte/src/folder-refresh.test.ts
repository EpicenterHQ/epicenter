/**
 * Shared folder refresh over real files and active TanStack observers.
 * External writes arrive through polling without notifications. Hidden pages
 * do no periodic reads; returning and mounting cached queries read again.
 * A save never waits for a read, and a slow scan shows the save over the
 * older rows until a read after it arrives. Closing stops polling even while
 * a consumer remains subscribed.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/bun';
import type { DocumentReading } from '@epicenter/folder/documents';
import { QueryObserver } from '@tanstack/query-core';
import { defineFileRead } from './folder-queries.js';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';

const { createFolderContext } = await import('./folder-context.js');
const tables = { notes: Type.Object({ title: Type.String() }) };
const initial = '---\ntitle: Milk\n---\none\n\ntwo\n';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
	visibility('visible');
});
function visibility(value: 'hidden' | 'visible') {
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		value,
	});
	window.dispatchEvent(new Event('visibilitychange'));
}
async function until(check: () => boolean, timeout = 4_000) {
	const end = performance.now() + timeout;
	while (!check()) {
		if (performance.now() > end) throw new Error('The folder did not refresh');
		await Bun.sleep(10);
	}
}
async function setup() {
	visibility('visible');
	const directory = await mkdtemp(join(tmpdir(), 'folder-refresh-'));
	await mkdir(join(directory, 'notes'));
	await writeFile(join(directory, 'notes/milk.md'), initial);
	const folder = expectOk(
		await openFolder({ directory, tables, saveAfterMs: 60_000 }),
	);
	const context = createFolderContext(folder);
	cleanup.push(async () => {
		await context.close();
		await rm(directory, { recursive: true, force: true });
	});
	let reads = 0;
	const list = folder.tables.notes.list;
	folder.tables.notes.list = () => {
		reads++;
		return list();
	};
	const observer = new QueryObserver(
		context.queryClient,
		context.queries.rows('notes'),
	);
	cleanup.push(observer.subscribe(() => {}));
	await until(() => observer.getCurrentResult().data !== undefined);
	const cached = () =>
		observer.getCurrentResult().data!.find((row) => row.id === 'milk')!;
	return { directory, folder, context, observer, cached, reads: () => reads };
}

test('visible polling discovers outside edits and preserves a pending row draft', async () => {
	const { directory, folder, cached } = await setup();
	// The list's read answered the edit's document.
	const edit = folder.tables.notes.edit('milk');
	expectOk(edit.change({ fields: { title: 'Typed here' } }));
	await writeFile(
		join(directory, 'notes/milk.md'),
		initial.replace('two', 'Outside edit'),
	);
	await until(() => cached().body.includes('Outside edit'));
	expect(edit.getPending()).toBeDefined();
	// The poll's read reached the edit too: the outside body under the typing.
	expect(edit.getRow()?.fields.title).toBe('Typed here');
	expect(edit.getRow()?.body).toContain('Outside edit');
	await edit.save();
	expect(edit.getPending()).toBeUndefined();
	expect(edit.getRow()?.fields.title).toBe('Typed here');
	await until(() => cached().fields.title === 'Typed here');
	expect(cached().body).toContain('Outside edit');
});

test('hidden pages do not poll and becoming visible refreshes without waiting for a tick', async () => {
	const { directory, reads, cached } = await setup();
	visibility('hidden');
	const before = reads();
	await writeFile(
		join(directory, 'notes/milk.md'),
		initial.replace('Milk', 'Outside'),
	);
	await Bun.sleep(2_200);
	expect(reads()).toBe(before);
	expect(cached().fields.title).toBe('Milk');
	visibility('visible');
	await until(() => cached().fields.title === 'Outside', 700);
	expect(reads()).toBe(before + 1);
});

test('inactive cache entries do not poll, and mounting one reads fresh storage', async () => {
	const { directory, context } = await setup();
	let reads = 0;
	const options = {
		queryKey: [...context.queries.key, 'file', 'notes/milk.md'],
		queryFn: async () => {
			reads++;
			return await Bun.file(join(directory, 'notes/milk.md')).text();
		},
	};
	await context.queryClient.fetchQuery(options);
	await writeFile(join(directory, 'notes/milk.md'), 'Changed outside');
	await Bun.sleep(2_200);
	expect(reads).toBe(1);
	const observer = new QueryObserver(context.queryClient, options);
	cleanup.push(observer.subscribe(() => {}));
	await until(
		() => observer.getCurrentResult().data === 'Changed outside',
		700,
	);
	expect(reads).toBe(2);
});

test('a known path refresh leaves unrelated file queries alone', async () => {
	const { context } = await setup();
	const reads = { a: 0, b: 0 };
	for (const path of ['a', 'b'] as const) {
		const observer = new QueryObserver(context.queryClient, {
			...context.queries.file(
				path,
				defineFileRead('text', async () => ++reads[path]),
			),
		});
		cleanup.push(observer.subscribe(() => {}));
	}
	await until(() => reads.a === 1 && reads.b === 1);
	await context.refresh(['a']);
	expect(reads).toEqual({ a: 2, b: 1 });
});

test('a reported change leaves an edit read query alone; an asked-for refresh reads it', async () => {
	const { folder, context } = await setup();
	const edit = folder.tables.notes.edit('milk');
	let reads = 0;
	const observer = new QueryObserver(
		context.queryClient,
		context.queries.read({
			path: edit.path,
			read: () => {
				reads++;
				return edit.read();
			},
		}),
	);
	cleanup.push(observer.subscribe(() => {}));
	await until(() => reads === 1);
	expectOk(edit.change({ fields: { title: 'Typed here' } }));
	await edit.save();
	await Bun.sleep(50);
	expect(reads).toBe(1);
	await context.refresh([edit.path]);
	expect(reads).toBe(2);
	await context.refresh();
	expect(reads).toBe(3);
});

test('a save lands without waiting for a slow scan, whose older rows never replace it in the edit', async () => {
	const { folder, cached, reads } = await setup();
	const gate = Promise.withResolvers<void>();
	const list = folder.tables.notes.list;
	let held = false,
		active = 0,
		maximum = 0;
	folder.tables.notes.list = async () => {
		active++;
		maximum = Math.max(maximum, active);
		try {
			const result = await list();
			if (!held) {
				held = true;
				await gate.promise;
			}
			return result;
		} finally {
			active--;
		}
	};
	cleanup.push(() => gate.resolve());
	await until(() => held);
	const edit = folder.tables.notes.edit('milk');
	const before = cached();
	expectOk(edit.change({ fields: { title: 'Saved while reading' } }));
	await edit.save();
	expect(edit.getPending()).toBeUndefined();
	expect(folder.getStatus().saving).toBe(false);
	expect(before.fields.title).toBe('Milk');
	expect(edit.getRow()?.fields.title).toBe('Saved while reading');
	// A second polling tick must join the slow scan, not replace it.
	await Bun.sleep(2_200);
	expect(maximum).toBe(1);
	gate.resolve();
	await Bun.sleep(0);
	// The scan read before the save: the edit keeps what the save stored.
	expect(edit.getRow()?.fields.title).toBe('Saved while reading');
	await until(() => cached().fields.title === 'Saved while reading');
	expect(edit.getRow()?.fields.title).toBe('Saved while reading');
	expect(maximum).toBe(1);
	expect(reads()).toBeLessThanOrEqual(3);
}, 10_000);

test('close stops periodic reads even if a view remains subscribed', async () => {
	const { context, reads } = await setup();
	await context.close();
	const before = reads();
	await Bun.sleep(2_200);
	expect(reads()).toBe(before);
	expect(context.queryClient.getQueryCache().getAll()).toHaveLength(0);
});

test('multiple observers share one periodic read and expensive reads get idle time', async () => {
	const { context, folder, reads } = await setup();
	const beforeMount = reads();
	const second = new QueryObserver(
		context.queryClient,
		context.queries.rows('notes'),
	);
	cleanup.push(second.subscribe(() => {}));
	await until(() => context.queryClient.isFetching() === 0);
	expect(reads()).toBe(beforeMount);
	const before = reads();
	const list = folder.tables.notes.list;
	folder.tables.notes.list = async () => {
		const result = await list();
		await Bun.sleep(600);
		return result;
	};
	await until(() => reads() > before);
	await until(() => context.queryClient.isFetching() === 0);
	expect(reads()).toBe(before + 1);
	await Bun.sleep(2_300);
	expect(reads()).toBe(before + 1);
}, 8_000);

test('a path refresh covers every representation and aggregate, leaving unrelated files alone', async () => {
	const { context, folder, directory, cached } = await setup();
	const reads = { text: 0, size: 0, other: 0 };
	const text = defineFileRead('text', async (files, path) => {
		reads.text++;
		const file = expectOk(await files.read(path));
		return file ? await file.content.text() : null;
	});
	const size = defineFileRead('size', async (files, path) => {
		reads.size++;
		return expectOk(await files.read(path))?.content.size ?? 0;
	});
	const other = defineFileRead('other', async () => ++reads.other);
	const textOptions = context.queries.file('notes/milk.md', text);
	const observers = [
		new QueryObserver(context.queryClient, textOptions),
		new QueryObserver(
			context.queryClient,
			context.queries.file('notes/milk.md', size),
		),
		new QueryObserver(
			context.queryClient,
			context.queries.file('notes-other/milk.md', other),
		),
		new QueryObserver(context.queryClient, context.queries.files()),
		new QueryObserver(context.queryClient, context.queries.documents()),
	];
	for (const observer of observers) cleanup.push(observer.subscribe(() => {}));
	await until(() => context.queryClient.isFetching() === 0);
	const before = { ...reads };
	await writeFile(
		join(directory, 'notes/milk.md'),
		initial.replace('Milk', 'Changed'),
	);
	await context.refresh(['notes']);
	expect(cached().fields.title).toBe('Changed');
	const changed = context.queryClient.getQueryData(textOptions.queryKey);
	expect(changed ?? '').toContain('Changed');
	expect(reads).toEqual({
		text: before.text + 1,
		size: before.size + 1,
		other: before.other,
	});
	expect(
		context.queryClient.getQueryData<string[]>(
			context.queries.files().queryKey,
		),
	).toEqual(['notes/milk.md']);
	expect(
		context.queryClient.getQueryData<DocumentReading>(
			context.queries.documents().queryKey,
		)?.documents[0]?.fields.title,
	).toBe('Changed');
	// Actual committed writes use the context's listener, without app listeners.
	const from = expectOk(await folder.files.read('notes/milk.md'))!;
	expectOk(
		await folder.files.write(
			'notes/milk.md',
			new Uint8Array(await from.content.arrayBuffer()),
			initial.replace('Milk', 'Own save'),
		),
	);
	await until(
		() =>
			cached().fields.title === 'Own save' &&
			context.queryClient
				.getQueryData(textOptions.queryKey)
				?.includes('Own save') === true,
	);
	const settled = { ...reads };
	await context.refresh([]);
	expect(reads).toEqual(settled);
});

test('refresh forgets unobserved files while disabled observers stay attached', async () => {
	const { context, folder } = await setup();
	const reader = defineFileRead('text', async (files, path) => {
		const file = expectOk(await files.read(path));
		return file ? await file.content.text() : null;
	});
	const options = context.queries.file('notes/milk.md', reader);
	const initialText = await context.queryClient.fetchQuery(options);
	expect(initialText ?? '').toContain('Milk');
	await context.refresh(['notes/milk.md']);
	expect(context.queryClient.getQueryState(options.queryKey)).toBeUndefined();
	const disabled = new QueryObserver(context.queryClient, {
		...options,
		enabled: false,
	});
	cleanup.push(disabled.subscribe(() => {}));
	const query = context.queryClient
		.getQueryCache()
		.find({ queryKey: options.queryKey, exact: true });
	await context.refresh(['notes/milk.md']);
	expect(
		context.queryClient
			.getQueryCache()
			.find({ queryKey: options.queryKey, exact: true }),
	).toBe(query);
	const before = expectOk(await folder.files.read('notes/milk.md'))!;
	expectOk(
		await folder.files.delete(
			'notes/milk.md',
			new Uint8Array(await before.content.arrayBuffer()),
		),
	);
	await context.refresh(['notes/milk.md']);
	expectOk(await folder.files.write('notes/milk.md', null, 'New empty file'));
	await context.refresh(['notes/milk.md']);
	disabled.setOptions(options);
	await until(() => disabled.getCurrentResult().data === 'New empty file');
	expect(disabled.getCurrentResult().data).toBe('New empty file');
});

test('refresh joins an unobserved prefetch before forgetting its old file bytes', async () => {
	const { context, directory } = await setup();
	const gate = Promise.withResolvers<void>();
	let reading = false;
	const reader = defineFileRead('text', async (files, path) => {
		const file = expectOk(await files.read(path))!;
		const text = await file.content.text();
		reading = true;
		await gate.promise;
		return text;
	});
	const options = context.queries.file('notes/milk.md', reader);
	const fetching = context.queryClient.fetchQuery(options);
	cleanup.push(() => gate.resolve());
	await until(() => reading);
	await writeFile(join(directory, 'notes/milk.md'), 'Changed during prefetch');
	let finished = false;
	const refreshing = context.refresh(['notes/milk.md']).then(() => {
		finished = true;
	});
	await Bun.sleep(0);
	expect(finished).toBe(false);
	gate.resolve();
	await Promise.all([fetching, refreshing]);
	expect(context.queryClient.getQueryState(options.queryKey)).toBeUndefined();
	const freshText = await context.queryClient.fetchQuery(options);
	expect(freshText).toBe('Changed during prefetch');
});
