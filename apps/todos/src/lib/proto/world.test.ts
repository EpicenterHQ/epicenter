/**
 * PROTOTYPE. What a component test must do to supply the world under (c)
 * context and (f) an awaited module promise, with the same plain fake.
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import type { World } from './open.js';

const fake = {
	folder: {},
	todos: {
		loading: false,
		items: [
			{ id: 'a', title: 'A', done: false },
			{ id: 'b', title: 'B', done: true },
		],
	},
} as unknown as World;

// (f) only: the module's promise is replaced before any component imports it.
mock.module(join(import.meta.dir, 'f/app.ts'), () => ({
	world: Promise.resolve(fake),
	reopen() {},
}));

const { flushSync, mount, settled, unmount } = await import('svelte');

test('(c) context: a harness sets the fake; the content is there at once', async () => {
	const { default: WithWorld } = await import('./c/WithWorld.test-support.svelte');
	const { default: ListC } = await import('./c/ListC.svelte');
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(WithWorld, { target, props: { world: fake, Child: ListC } });
	flushSync();
	expect(target.textContent).toContain('option c: 2 todos');
	expect(target.textContent).toContain('helper: 1 open');
	unmount(view);
});

test('(f) awaited promise: mock.module; the content is absent until settled', async () => {
	const { default: ListF } = await import('./f/ListF.svelte');
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(ListF, { target, props: {} });
	flushSync();
	const atOnce = target.textContent ?? '';
	await settled();
	const afterSettled = target.textContent ?? '';
	let waits = 0;
	while (!target.textContent?.includes('option f') && waits < 100) {
		await Bun.sleep(1);
		flushSync();
		waits++;
	}
	console.log(
		`(f) right after mount: "${atOnce.trim()}"; after settled(): "${afterSettled.trim()}"; after ${waits} sleeps: "${target.textContent?.trim().slice(0, 40)}"`,
	);
	expect(atOnce).not.toContain('option f');
	expect(target.textContent).toContain('option f: 2 todos');
	unmount(view);
});
