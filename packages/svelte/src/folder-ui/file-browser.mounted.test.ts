/**
 * File Browser Mounted Tests
 *
 * Mounts the real `FileBrowser` in jsdom over a plain listing, inside the
 * sidebar and tooltip providers an app root gives it. Keys are delivered to
 * the focused row, and names typed into the field it opens.
 *
 * Key behaviors:
 * - Folders list before files, and only open folders show their contents
 * - Arrow keys move between rows; Right opens a folder and Left closes it or
 *   goes to its parent; Home and End reach the ends
 * - Clicking a file opens it through the app; clicking a folder toggles it
 * - F2 renames in place: Enter applies the name, a refused name keeps the
 *   field, and Escape returns focus to the row
 * - New file creates in the folder root through the app
 * - Delete asks the app
 * - The app chooses the icon for its own items
 *
 * Run with `bun run test:mounted`.
 */
import '../svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import type { FileListing } from '@epicenter/folder';
import type { Component } from 'svelte';
import { type } from '../svelte-dom.test-support.js';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { SvelteSet } = await import('svelte/reactivity');
const { default: Providers } = await import('./fixtures/Providers.svelte');
const { default: FileBrowser } = await import('./file-browser.svelte');
const { default: ListTodoIcon } = await import(
	'@lucide/svelte/icons/list-todo'
);

const listing: FileListing = {
	directories: ['notes', 'todos', '.git'],
	files: [
		{ path: 'readme.md', size: 10 },
		{ path: 'todos/walk.md', size: 20 },
		{ path: 'todos/swim.md', size: 20 },
		{ path: 'notes/a.txt', size: 1 },
		{ path: '.git/HEAD', size: 1 },
	],
};

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});

function setup(options: { renameProblem?: string } = {}) {
	const calls: unknown[][] = [];
	const expanded = new SvelteSet<string>(['todos']);
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(Providers, {
		target,
		props: {
			component: FileBrowser as Component<object>,
			props: {
				listing,
				listingError: undefined,
				expanded,
				selected: (path: string) => path === 'todos/walk.md',
				icon: (path: string) =>
					path.startsWith('todos/') ? ListTodoIcon : undefined,
				emptyDescription: 'Add a todo.',
				onRefresh: () => calls.push(['refresh']),
				onOpen: (path: string) => calls.push(['open', path]),
				onCreate: async (
					directory: string,
					name: string,
					type: 'file' | 'folder',
				) => {
					calls.push(['create', directory, name, type]);
					return undefined;
				},
				onRename: async (path: string, name: string) => {
					calls.push(['rename', path, name]);
					return options.renameProblem;
				},
				onDelete: (path: string) => calls.push(['delete', path]),
			},
		},
	});
	flushSync();
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	const rows = () =>
		[...target.querySelectorAll<HTMLElement>('[data-row]')].map(
			(row) => row.dataset.row,
		);
	const row = (path: string) => {
		const found = target.querySelector<HTMLElement>(
			`[data-row="${CSS.escape(path)}"]`,
		);
		if (found === null) throw new Error(`No row for ${path}`);
		return found;
	};
	/** Focus a row and deliver a key to it, as the keyboard does. */
	const press = (path: string, key: string) => {
		const element = row(path);
		element.focus();
		element.dispatchEvent(
			new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
		);
		flushSync();
	};
	const focused = () =>
		document.activeElement instanceof HTMLElement
			? document.activeElement.dataset.row
			: undefined;
	const field = () =>
		target.querySelector<HTMLInputElement>('input[name="name"]');
	return { target, calls, expanded, rows, row, press, focused, field };
}

test('folders list before files, and only open folders show their contents', () => {
	const { rows, row } = setup();
	expect(rows()).toEqual([
		'notes',
		'todos',
		'todos/swim.md',
		'todos/walk.md',
		'readme.md',
	]);
	expect(row('todos').getAttribute('aria-expanded')).toBe('true');
	expect(row('notes').getAttribute('aria-expanded')).toBe('false');
	expect(row('todos/walk.md').getAttribute('aria-current')).toBe('true');
	expect(row('readme.md').getAttribute('aria-current')).toBeNull();
});

test('arrow keys move between rows and open and close folders', () => {
	const { press, focused, rows } = setup();
	press('notes', 'ArrowDown');
	expect(focused()).toBe('todos');
	press('todos', 'ArrowUp');
	expect(focused()).toBe('notes');
	press('notes', 'End');
	expect(focused()).toBe('readme.md');
	press('readme.md', 'Home');
	expect(focused()).toBe('notes');

	press('notes', 'ArrowRight');
	expect(rows()).toContain('notes/a.txt');
	press('notes', 'ArrowRight');
	expect(focused()).toBe('notes/a.txt');
	press('notes/a.txt', 'ArrowLeft');
	expect(focused()).toBe('notes');
	press('notes', 'ArrowLeft');
	expect(rows()).not.toContain('notes/a.txt');
});

test('clicking a file opens it through the app; clicking a folder toggles it', () => {
	const { row, calls, expanded } = setup();
	row('readme.md').click();
	expect(calls).toEqual([['open', 'readme.md']]);
	row('todos').click();
	flushSync();
	expect(expanded.has('todos')).toBe(false);
	expect(calls).toEqual([['open', 'readme.md']]);
});

test('F2 renames in place, and Escape returns focus to the row', async () => {
	const { press, field, calls, focused, target } = setup();
	press('readme.md', 'F2');
	const input = field();
	expect(input?.value).toBe('readme.md');
	expect(input?.getAttribute('aria-label')).toBe('New name for readme.md');
	type(input, 'intro.md');
	input?.form?.requestSubmit();
	await tick();
	await tick();
	expect(calls).toEqual([['rename', 'readme.md', 'intro.md']]);
	expect(field()).toBeNull();

	press('notes', 'F2');
	expect(field()).toBeNull();
	press('todos/walk.md', 'F2');
	field()?.dispatchEvent(
		new KeyboardEvent('keydown', {
			key: 'Escape',
			bubbles: true,
			cancelable: true,
		}),
	);
	await tick();
	await tick();
	expect(field()).toBeNull();
	expect(focused()).toBe('todos/walk.md');
	expect(target.querySelectorAll('input').length).toBe(0);
});

test('a refused name keeps the field and what was typed', async () => {
	const { press, field, calls } = setup({ renameProblem: 'Taken' });
	press('readme.md', 'F2');
	type(field(), 'taken.md');
	field()?.form?.requestSubmit();
	await tick();
	await tick();
	expect(calls).toEqual([['rename', 'readme.md', 'taken.md']]);
	expect(field()?.value).toBe('taken.md');
});

test('New file creates in the folder root through the app', async () => {
	const { target, field, calls } = setup();
	target
		.querySelector<HTMLButtonElement>('button[aria-label="New file"]')
		?.click();
	flushSync();
	expect(field()?.getAttribute('aria-label')).toBe(
		'New file name in the folder root',
	);
	type(field(), 'plan.md');
	field()?.form?.requestSubmit();
	await tick();
	await tick();
	expect(calls).toEqual([['create', '', 'plan.md', 'file']]);
});

test('Delete asks the app', () => {
	const { press, calls } = setup();
	press('readme.md', 'Delete');
	expect(calls).toEqual([['delete', 'readme.md']]);
});

test('the app chooses the icon for its own items', () => {
	const { row } = setup();
	expect(row('todos/walk.md').querySelector('svg')?.classList).toContain(
		'lucide-list-todo',
	);
	expect(row('readme.md').querySelector('svg')?.classList).toContain(
		'lucide-file-text',
	);
});
