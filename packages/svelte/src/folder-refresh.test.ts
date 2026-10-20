/**
 * Shared folder refresh over real files and active TanStack observers.
 * External writes arrive through polling without notifications. Hidden pages
 * do no periodic reads; returning and mounting cached queries read again.
 * Slow reads, successful saves and failed drafts retain typed input, and
 * closing stops polling even while a consumer remains subscribed.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder/bun';
import { QueryObserver } from '@tanstack/query-core';
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
	const folder = expectOk(await openFolder({ directory, tables }));
	const context = createFolderContext(folder, { saveAfterMs: 60_000 });
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
	const { directory, context, cached } = await setup();
	const editor = context.edits.row('notes', 'milk');
	editor.change(cached(), { fields: { title: 'Typed here' } });
	await writeFile(
		join(directory, 'notes/milk.md'),
		initial.replace('two', 'Outside edit'),
	);
	await until(() => cached().body.includes('Outside edit'));
	expect(editor.held).toBe(true);
	expect(editor.shown(cached()).fields.title).toBe('Typed here');
	await editor.save();
	expect(editor.held).toBe(false);
	expect(cached().fields.title).toBe('Typed here');
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
			queryKey: [...context.queries.key, 'file', path],
			queryFn: async () => ++reads[path],
		});
		cleanup.push(observer.subscribe(() => {}));
	}
	await until(() => reads.a === 1 && reads.b === 1);
	await context.refresh({
		queryKey: [...context.queries.key, 'file', 'a'],
		exact: true,
	});
	expect(reads).toEqual({ a: 2, b: 1 });
});

test('a save waits for a post-commit read instead of releasing its draft over an old poll', async () => {
	const { folder, context, cached, reads } = await setup();
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
	const editor = context.edits.row('notes', 'milk');
	editor.change(cached(), { fields: { title: 'Saved while reading' } });
	const saving = editor.save();
	await until(() => folder.status.saving === false);
	// A second polling tick must join the slow scan, not replace it.
	await Bun.sleep(2_200);
	expect(editor.held).toBe(true);
	expect(maximum).toBe(1);
	gate.resolve();
	await saving;
	expect(editor.held).toBe(false);
	expect(cached().fields.title).toBe('Saved while reading');
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
