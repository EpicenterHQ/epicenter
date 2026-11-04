/**
 * PROTOTYPE. What a component test writes under (s) and under (c) as
 * reviewed (cr): a page given a fake app, and the opening gate itself.
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import type { App as AppC } from './cr/app.js';
import type { Folder, FolderState } from './s/folder.js';

mock.module('$app/state', () => ({ page: { url: new URL('http://localhost/') } }));
const items = [
	{ id: 'a', title: 'A', done: false },
	{ id: 'b', title: 'B', done: true },
];
let opening: (value: unknown) => void = () => {};
mock.module(join(import.meta.dir, 'open.ts'), () => ({
	openWorld: () => new Promise((resolve) => (opening = resolve)),
	closeWorld() {},
}));

const { createRawSnippet, flushSync, mount, unmount } = await import('svelte');
const { default: WithApp } = await import('./WithApp.test-support.svelte');
const label = (count: number) => `${count} todos`;
const target = () => {
	const main = document.createElement('main');
	document.body.replaceChildren(main);
	return main;
};

/** A folder whose state the test sets. */
function fakeFolder<C>(state: FolderState<C>): Folder<C> & { set(next: FolderState<C>): void } {
	const listeners = new Set<() => void>();
	return {
		state: () => state,
		client: () => (state as { client: C }).client,
		subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
		retry() {},
		[Symbol.dispose]() {},
		set(next) {
			state = next;
			for (const fn of listeners) fn();
		},
	};
}
const client = {
	todos: {
		list: async () => Ok({ items, invalid: [] }),
		subscribe: () => () => {},
		replace() {},
	},
};

test('(c) page: a harness sets a fake app with todos; flushSync shows it', async () => {
	const { default: Page } = await import('../../routes/proto/cr/+page.svelte');
	const app = { todos: { loading: false, items }, label } as unknown as AppC;
	const { setApp } = await import('./cr/app.js');
	const main = target();
	const view = mount(WithApp, { target: main, props: { set: setApp as (app: unknown) => void, app, Child: Page } });
	flushSync();
	expect(main.textContent).toContain('option cr: 2 todos');
	unmount(view);
});

test('(s) page: a harness sets a fake app with a ready folder; the listing needs a tick', async () => {
	const { default: Page } = await import('../../routes/proto/s/+page.svelte');
	const { setApp } = await import('./s/app.js');
	const models = { get: () => null, set() {} };
	const app = { folder: fakeFolder({ status: 'ready', client }), models, label };
	const main = target();
	const view = mount(WithApp, { target: main, props: { set: setApp as (app: unknown) => void, app, Child: Page } });
	flushSync();
	const atOnce = main.textContent ?? '';
	await Promise.resolve();
	flushSync();
	console.log(`(s) page after flushSync: "${atOnce.trim().slice(0, 30)}"; after one tick: "${main.textContent?.trim().slice(0, 30)}"`);
	expect(main.textContent).toContain('option s: 2 todos');
	unmount(view);
});

test('(s) <Opening>: every state is driven by a fake folder and flushSync', async () => {
	const { default: Opening } = await import('./s/Opening.svelte');
	const folder = fakeFolder<unknown>({ status: 'opening' });
	const children = createRawSnippet(() => ({ render: () => '<p>pages</p>' }));
	const main = target();
	const view = mount(Opening, { target: main, props: { folder, children } });
	flushSync();
	expect(main.textContent).toContain('Opening');
	folder.set({ status: 'failed', error: new Error('nope') as never });
	flushSync();
	expect(main.textContent).toContain('recovery: nope');
	folder.set({ status: 'ready', client: {} });
	flushSync();
	expect(main.textContent).toBe('pages');
	unmount(view);
});

test('(c) layout gate: needs mock.module of the opener and waits past flushSync', async () => {
	const { default: Layout } = await import('../../routes/proto/cr/+layout.svelte');
	const children = createRawSnippet(() => ({ render: () => '<p>pages</p>' }));
	const main = target();
	const view = mount(Layout, { target: main, props: { children } });
	flushSync();
	const atOnce = main.textContent?.trim();
	opening({ folder: {}, todos: { loading: false, items } });
	flushSync();
	const afterResolve = main.textContent?.trim();
	let waits = 0;
	while (main.textContent?.trim() !== 'pages' && waits < 100) {
		await Bun.sleep(1);
		flushSync();
		waits++;
	}
	console.log(`(c) layout at once: "${atOnce}"; after resolve+flushSync: "${afterResolve}"; after ${waits} sleeps: "${main.textContent?.trim()}"`);
	expect(main.textContent?.trim()).toBe('pages');
	unmount(view);
});
