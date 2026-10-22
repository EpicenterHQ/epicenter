/** Folder watch events, targeted query invalidation, and explicit/focus reconciliation.
 * No periodic read is needed. Slow reads are joined and cannot replace newer editor input.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/bun';
import type { DocumentReading } from '@epicenter/folder/documents';
import { QueryObserver } from '@tanstack/query-core';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { createNativeFolder } from '../../folder/src/native/engine.js';
import { nativeStorage } from '../../folder/src/native/storage.js';
import { defineFileRead } from './folder-queries.js';

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
async function setup(watching = false) {
	visibility('visible');
	const directory = await mkdtemp(join(tmpdir(), 'folder-refresh-'));
	await mkdir(join(directory, 'notes'));
	await writeFile(join(directory, 'notes/milk.md'), initial);
	const root = await realpath(directory);
	// Most cases deliberately omit events to exercise reconciliation after a gap.
	const folder = watching
		? expectOk(
				await openFolder({ directory: root, tables, saveAfterMs: 60_000 }),
			)
		: createNativeFolder({
				storage: nativeStorage(root),
				tables,
				directory: `refresh-test:${root}`,
				saveAfterMs: 60_000,
			});
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

test('native events update queries and an editor without periodic reads or replacing input', async () => {
	const { directory, folder, cached } = await setup(true);
	const edit = folder.tables.notes.document('milk');
	cleanup.push(edit.subscribe(() => {}));
	await until(() => edit.getSnapshot().content !== undefined);
	await writeFile(
		join(directory, 'notes/milk.md'),
		initial.replace('two', 'Outside edit'),
	);
	// The folder-wide hint reaches both the owner and the query context.
	await until(() => cached().body?.includes('Outside edit') === true);
	await until(
		() => edit.getSnapshot().content?.body?.includes('Outside edit') === true,
	);
	expectOk(edit.patch({ fields: { title: 'Typed here' } }));
	await writeFile(
		join(directory, 'notes/milk.md'),
		initial.replace('two', 'Second outside edit'),
	);
	await until(() => cached().body?.includes('Second outside edit') === true);
	await Bun.sleep(50);
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { fields: { title: 'Typed here' } },
	});
	expect(edit.getSnapshot().content?.body).toBe('one\n\nOutside edit\n');
	// The last publication wins whole.
	expectOk(await edit.save());
	await until(() => cached().fields?.title === 'Typed here');
	expect(cached().body).toBe('one\n\nOutside edit\n');
});

test('without a delivered hint there is no polling; becoming visible reconciles sources and queries', async () => {
	const { directory, reads, cached, folder } = await setup();
	const edit = folder.tables.notes.document('milk');
	cleanup.push(edit.subscribe(() => {}));
	await until(() => edit.getSnapshot().content !== undefined);
	visibility('hidden');
	const before = reads();
	await writeFile(
		join(directory, 'notes/milk.md'),
		initial.replace('Milk', 'Outside'),
	);
	await Bun.sleep(2_200);
	expect(reads()).toBe(before);
	expect(cached().fields?.title).toBe('Milk');
	visibility('visible');
	await until(() => cached().fields?.title === 'Outside', 700);
	await until(
		() => edit.getSnapshot().content?.fields?.title === 'Outside',
		700,
	);
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

test('a save lands without waiting for a slow scan, whose older rows never replace it in the edit', async () => {
	const { folder, cached, reads, context } = await setup();
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
	const refreshing = context.refresh(['notes']);
	await until(() => held);
	const edit = folder.tables.notes.document('milk');
	expectOk(await edit.refresh());
	const before = cached();
	expectOk(edit.patch({ fields: { title: 'Saved while reading' } }));
	expectOk(await edit.save());
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(folder.getStatus().saving).toBe(false);
	expect(before.fields?.title).toBe('Milk');
	const title = () => edit.getSnapshot().content?.fields?.title;
	expect(title()).toBe('Saved while reading');
	// A second invalidation joins the same scan.
	const again = context.refresh(['notes']);
	await Bun.sleep(20);
	expect(maximum).toBe(1);
	gate.resolve();
	await Promise.all([refreshing, again]);
	// The scan read before the save: the editor keeps what the save stored.
	expect(title()).toBe('Saved while reading');
	await until(() => cached().fields?.title === 'Saved while reading');
	expect(title()).toBe('Saved while reading');
	expect(maximum).toBe(1);
	expect(reads()).toBeLessThanOrEqual(3);
}, 10_000);

test('close stops reconciliation even if a view remains subscribed', async () => {
	const { context, reads } = await setup();
	await context.close();
	const before = reads();
	await Bun.sleep(2_200);
	expect(reads()).toBe(before);
	expect(context.queryClient.getQueryCache().getAll()).toHaveLength(0);
});

test('multiple observers share reads and no timer starts another read', async () => {
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
	await Bun.sleep(2_200);
	expect(reads()).toBe(before);
	await context.refresh();
	expect(reads()).toBe(before + 1);
	await Bun.sleep(50);
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
	expect(cached().fields?.title).toBe('Changed');
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
		)?.documents[0]?.fields?.title,
	).toBe('Changed');
	// Actual committed writes use the context's listener, without app listeners.
	expectOk(
		await folder.files.write(
			'notes/milk.md',
			initial.replace('Milk', 'Own save'),
		),
	);
	await until(
		() =>
			cached().fields?.title === 'Own save' &&
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
	expectOk(await folder.files.delete('notes/milk.md'));
	await context.refresh(['notes/milk.md']);
	expectOk(await folder.files.write('notes/milk.md', 'New empty file'));
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
