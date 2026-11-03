/**
 * Mounted Todo List Tests
 *
 * The real list over a real device client in a temporary directory. The
 * list reads this page's `todos` from `$lib/app`; a test binds its own world
 * with `mock.module` before it loads the component, so the module that opens
 * the page's world never runs.
 *
 * Key behaviors:
 * - The list shows the folder's todos, open ones first
 * - Add writes the todo's file and opens it
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice } from '@epicenter/folder/node';
import { unwrap } from 'wellcrafted/result';
import {
	button,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { todos as contract } from '../contract.js';

const root = await mkdtemp(join(tmpdir(), 'epicenter-todos-'));
await mkdir(join(root, 'todos'));
await writeFile(join(root, 'todos/a.md'), '---\ntitle: Done one\ndone: true\n---\n');
await writeFile(join(root, 'todos/b.md'), '---\ntitle: Open one\ndone: false\n---\n');

const { fromClient } = await import('@epicenter/svelte/client');
const todos = fromClient(unwrap(await openDevice(contract, { path: root }))).todos;

// This test's world, in place of the page's.
mock.module(join(import.meta.dir, '../app.ts'), () => ({ todos }));

const { flushSync, mount, unmount } = await import('svelte');
const { default: TodoList } = await import('./TodoList.svelte');

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
	document.body.replaceChildren();
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function until(check: () => boolean, timeout = 5000) {
	const end = Date.now() + timeout;
	flushSync();
	while (!check()) {
		if (Date.now() > end) throw new Error('Timed out waiting');
		await Bun.sleep(5);
		flushSync();
	}
}

function render(onOpen: (id: string) => void = () => {}) {
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(TodoList, { target, props: { onOpen } });
	cleanup.push(() => void unmount(view));
	return target;
}

const rows = (target: Element) =>
	[...target.querySelectorAll('[data-todo]')].map((row) => row.textContent?.trim());

test('the list shows the folder’s todos, open ones first', async () => {
	const target = render();
	await until(() => rows(target).length === 2);
	expect(rows(target)).toEqual(['Open one', 'Done one']);
});

test('Add writes the todo’s file and opens it', async () => {
	const opened: string[] = [];
	const target = render((id) => opened.push(id));
	await until(() => rows(target).length >= 2);
	type(target.querySelector('input[aria-label="New todo title"]'), 'Fresh');
	flushSync();
	button(target, 'Add').closest('form')?.dispatchEvent(
		new Event('submit', { bubbles: true, cancelable: true }),
	);
	await until(() => opened.length === 1);
	expect(await readdir(join(root, 'todos'))).toContain(`${opened[0]}.md`);
	await until(() => rows(target).includes('Fresh'));
});
