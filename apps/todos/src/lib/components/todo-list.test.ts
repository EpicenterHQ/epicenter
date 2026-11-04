/**
 * The todo list over the app's own values (`$lib/app`), as the pages read
 * them. Under the `test` condition the folder is in memory and the account
 * signed out; the test seeds the folder through its ordinary methods and
 * mocks no module.
 *
 * Key behaviors:
 * - The list shows the folder's todos, open ones first
 * - Adding a todo writes it to the folder and opens it
 * - The account starts signed out
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, test } from 'bun:test';

const { flushSync, mount, unmount } = await import('svelte');
const { account, folder } = await import('../app.js');
const { default: TodoList } = await import('./TodoList.svelte');

const settle = async () => {
	for (let turn = 0; turn < 3; turn++) {
		await Bun.sleep(0);
		flushSync();
	}
};

function target() {
	const main = document.createElement('main');
	document.body.replaceChildren(main);
	return main;
}

test('the list shows the folder’s todos, open ones first', async () => {
	await folder.todos.create({ id: '001', title: 'Milk', done: true });
	await folder.todos.create({ id: '002', title: 'Eggs', done: false });
	const main = target();
	const view = mount(TodoList, { target: main, props: {} });
	await settle();
	const rows = [...main.querySelectorAll('[data-todo]')].map((row) =>
		row.textContent?.trim(),
	);
	expect(rows).toEqual(['Eggs', 'Milk']);
	await unmount(view);
});

test('adding a todo writes it to the folder and opens it', async () => {
	let opened: string | undefined;
	const main = target();
	const view = mount(TodoList, {
		target: main,
		props: { title: 'Bread', onOpen: (id: string) => (opened = id) },
	});
	await settle();
	main
		.querySelector('form')
		?.dispatchEvent(new Event('submit', { cancelable: true }));
	await settle();
	expect(opened).toBeDefined();
	expect(folder.todos.get({ id: opened ?? '' })?.title).toBe('Bread');
	await unmount(view);
});

test('the account starts signed out', () => {
	expect(account?.state().status).toBe('signed-out');
});
