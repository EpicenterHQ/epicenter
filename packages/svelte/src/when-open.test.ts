/**
 * `<WhenOpen>` and the folder adapted once at module scope.
 *
 * Key behaviors:
 * - `<WhenOpen>` shows a spinner while the folder opens, Recovery with the
 *   typed error when it failed, the pages once it is open, and nothing once
 *   it is closed
 * - Recovery's Retry reopens the folder, and only the folder
 * - A page that throws shows the page error, never the folder's Recovery
 * - Leaving the page asks first while the folder is saving
 * - While the store cannot be reached, a status line says so: why opening
 *   waits, and, once open, that changes are waiting
 * - A folder wrapped by `reactive` at module scope stays reactive in a
 *   component that reads it, and an editor's fields bind to inputs
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { ClientError, defineContract } from '@epicenter/definition/contract';
import { openFolder } from '@epicenter/folder';
import { OpenFolderError } from '@epicenter/folder/core';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { Ok } from 'wellcrafted/result';

const { flushSync, mount, unmount } = await import('svelte');
const { reactive } = await import('./reactive.js');
const { default: WhenOpenHost } = await import(
	'./fixtures/WhenOpenHost.svelte'
);
const { default: TodoCount } = await import('./fixtures/TodoCount.svelte');
const { default: TodoEditor } = await import('./fixtures/TodoEditor.svelte');
const app = await import('./fixtures/app.test-support.js');

const contract = defineContract({
	collections: { todos: { path: 'todos/{id}.md' } },
});
/**
 * A folder in memory whose open waits until the test answers it, adapted as
 * an app adapts it, with the reveal a desktop folder has.
 */
function controlled() {
	const place = memory();
	const world = memoryFiles(place);
	let release = world.holdOpen();
	let undo = () => {};
	const raw = openFolder(contract, place);
	const adapted = reactive(raw);
	const revealed: string[] = [];
	return {
		raw,
		folder: {
			state: () => adapted.state(),
			unavailable: () => adapted.unavailable(),
			saving: () => adapted.saving(),
			todos: adapted.todos,
			reveal: async () => {
				revealed.push('Data');
				return Ok(null);
			},
		},
		revealed,
		world,
		/** Fail the open waiting now with `error`. */
		fail(error: OpenFolderError) {
			undo();
			undo = world.refuseOpen(error);
			release();
		},
		/** Make the next open wait. */
		hold() {
			release = world.holdOpen();
		},
		/** Let the open waiting now, or the next, open. */
		open() {
			undo();
			release();
		},
	};
}

const settle = async () => {
	await Bun.sleep(0);
	flushSync();
};

function target() {
	const main = document.createElement('main');
	document.body.replaceChildren(main);
	return main;
}

const recovery = (main: HTMLElement) =>
	main.querySelector('[data-testid="recovery"]');

test('a spinner while opening, Recovery with the typed error, and Retry reopens until the pages show', async () => {
	const { folder, fail, hold, open, revealed } = controlled();
	const main = target();
	const view = mount(WhenOpenHost, { target: main, props: { folder } });
	flushSync();
	expect(main.querySelector('[data-testid="pages"]')).toBeNull();
	expect(recovery(main)).toBeNull();
	expect(main.querySelector('[aria-live="polite"]')).not.toBeNull();

	fail(
		OpenFolderError.Disconnected({
			folder: '/Users/me/Epicenter/todos',
			target: '/Volumes/gone',
		}).error,
	);
	await settle();
	expect(main.textContent).toContain('Todos could not open its folder');
	expect(main.textContent).toContain('/Users/me/Epicenter/todos');

	const [retry, show] = [...main.querySelectorAll('button')];
	show?.click();
	await settle();
	expect(revealed).toEqual(['Data']);
	hold();
	retry?.click();
	flushSync();
	expect(recovery(main)).toBeNull();
	open();
	await settle();
	expect(main.querySelector('[data-testid="pages"]')?.textContent).toBe(
		'pages',
	);
	await unmount(view);
});

test('the pages go once the folder is closed', async () => {
	const { raw, folder, open } = controlled();
	open();
	const main = target();
	const view = mount(WhenOpenHost, { target: main, props: { folder } });
	await settle();
	expect(main.querySelector('[data-testid="pages"]')).not.toBeNull();
	raw[Symbol.dispose]();
	flushSync();
	expect(main.querySelector('[data-testid="pages"]')).toBeNull();
	expect(recovery(main)).toBeNull();
	await unmount(view);
});

test('a folder with no place to show offers Retry alone', async () => {
	const place = memory();
	memoryFiles(place).refuseOpen(
		OpenFolderError.StorageUnavailable({ cause: 'no private storage' }).error,
	);
	const raw = openFolder(contract, place);
	const main = target();
	const view = mount(WhenOpenHost, {
		target: main,
		props: { folder: reactive(raw) },
	});
	await settle();
	expect(recovery(main)).not.toBeNull();
	expect(
		[...main.querySelectorAll('button')].map((b) => b.textContent),
	).toEqual(['Retry']);
	await unmount(view);
});

test('a page that throws shows the page error, never the folder’s Recovery', async () => {
	const { folder, open } = controlled();
	open();
	const main = target();
	const view = mount(WhenOpenHost, {
		target: main,
		props: { folder, crash: true },
	});
	await settle();
	expect(recovery(main)).toBeNull();
	expect(
		main.querySelector('[data-testid="page-error"]')?.textContent,
	).toContain('page render bug');
	await unmount(view);
});

test('a folder wrapped once at module scope stays reactive in a component that reads it', async () => {
	const main = target();
	const view = mount(TodoCount, { target: main });
	flushSync();
	await settle();
	expect(main.textContent).toBe('0 todos');
	await app.raw.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	await settle();
	expect(main.textContent).toBe('1 todos');
	await unmount(view);
});

test('leaving the page asks first while the folder is saving, and not once it is saved', async () => {
	const { folder, open } = controlled();
	open();
	const main = target();
	const view = mount(WhenOpenHost, { target: main, props: { folder } });
	await settle();
	const leavingAsks = () => {
		const leaving = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(leaving);
		return leaving.defaultPrevented;
	};
	expect(leavingAsks()).toBe(false);
	const saving = folder.todos.set({ id: 'a' }, { body: 'text' });
	expect(leavingAsks()).toBe(true);
	await saving;
	expect(leavingAsks()).toBe(false);
	await unmount(view);
	// Unmounted, it asks nothing.
	void folder.todos.set({ id: 'a' }, { body: 'more' });
	expect(leavingAsks()).toBe(false);
});

test('while the store cannot be reached, a status line says why opening waits, and that changes are waiting once open', async () => {
	const { folder, world, open } = controlled();
	const main = target();
	const view = mount(WhenOpenHost, { target: main, props: { folder } });
	const unreachable = () =>
		main.querySelector('[data-testid="unreachable"]')?.textContent ?? null;
	const reachable = world.refuseOpen(
		ClientError.Unavailable({ cause: 'offline' }).error,
	);
	open();
	for (let turn = 0; turn < 100 && unreachable() === null; turn++)
		await settle();
	expect(unreachable()).toContain('offline');
	expect(main.querySelector('[data-testid="pages"]')).toBeNull();
	reachable();
	for (
		let turn = 0;
		turn < 200 && main.querySelector('[data-testid="pages"]') === null;
		turn++
	) {
		await Bun.sleep(10);
		flushSync();
	}
	expect(unreachable()).toBeNull();

	const undo = world.refuse('disk full');
	const saving = folder.todos.set({ id: 'a' }, { body: 'text' });
	for (let turn = 0; turn < 100 && unreachable() === null; turn++)
		await settle();
	expect(unreachable()).toContain('(disk full)');
	expect(unreachable()).toContain('Your changes will save');
	undo();
	await saving;
	flushSync();
	expect(unreachable()).toBeNull();
	await unmount(view);
});

test('an editor on the module-scope folder binds its fields to inputs, saves what is typed, and shows a change made elsewhere', async () => {
	type Edit = Parameters<Parameters<typeof TodoEditor>[1]['expose']>[0];
	await app.raw.todos.set({ id: 'b' }, { title: 'Eggs', done: false });
	let editor: Edit | undefined;
	const main = target();
	const view = mount(TodoEditor, {
		target: main,
		props: { id: 'b', expose: (edit: Edit) => (editor = edit) },
	});
	await settle();
	await settle();
	if (editor === undefined) throw new Error('expected the editor');
	const input = main.querySelector<HTMLInputElement>(
		'[data-testid="title-input"]',
	);
	const done = main.querySelector<HTMLInputElement>(
		'[data-testid="done-input"]',
	);
	expect(input?.value).toBe('Eggs');
	expect(done?.checked).toBe(false);

	if (input === null || done === null) throw new Error('expected the inputs');
	input.value = 'Brown eggs';
	input.dispatchEvent(new Event('input'));
	done.click();
	flushSync();
	expect(main.querySelector('[data-testid="saving"]')).not.toBeNull();
	expect(main.querySelector('[data-testid="title"]')?.textContent).toBe(
		'Brown eggs',
	);
	await editor.landed();
	await settle();
	expect(main.querySelector('[data-testid="saving"]')).toBeNull();
	const saved = (await app.raw.todos.list()).data?.items.find(
		(todo) => todo.id === 'b',
	);
	expect(saved).toMatchObject({ title: 'Brown eggs', done: true });

	// A write behind the editor's back: the bound input shows it.
	await app.raw.todos.set({ id: 'b' }, { title: 'Duck eggs' });
	await settle();
	expect(input.value).toBe('Duck eggs');
	await unmount(view);
});
