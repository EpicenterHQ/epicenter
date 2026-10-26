/**
 * Local Todos Mounted Tests
 *
 * Mounts the real Todos page in jsdom, as the layout mounts it, over an
 * in-memory IndexedDB with no OPFS: the page chooses this browser's local
 * folder, `openFolder({ tables: todosTables })`, and opens it through
 * `<OpenFolder>`. A second handle of the same profile stands in for
 * another tab. jsdom matches no media query, so the view lays out as on a
 * narrow screen.
 *
 * Key behaviors:
 * - Add, edit, complete, and delete persist across close and reopen
 * - Another tab's committed change updates clean controls; field patches merge
 * - Failed text stays visible for retry or discard; commands report failures
 * - A row that does not fit is listed with its source and issues, and an
 *   edit keeps fields the schema does not name
 * - A failed storage check opens nothing; Try again checks again
 * - The local path offers no Save version, Sync, or Connect
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
// Before the DOM: once a `window` exists, `fake-indexeddb/auto` installs
// IndexedDB on it rather than on the global the folder reads.
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	blur,
	button,
	click,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { todosTables } from '../../lib/definition.js';

const { flushSync, mount, unmount } = await import('svelte');
const state = await import('../../lib/app-state.test-support.svelte.ts');
const navigation = await import('../../lib/app-navigation.test-support.ts');
mock.module('$app/state', () => state);
mock.module('$app/navigation', () => navigation);
const { page } = state;
const { resetUrl } = navigation;
const { default: PageHost } = await import('./fixtures/PageHost.svelte');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	document.body.replaceChildren();
	resetUrl();
});

const DETAIL = 'section[aria-label="Todo"]';
const LIST = '[aria-label="Todo list"]';
const TITLE = `${DETAIL} input[aria-label="Title"]`;
const NOTES = `${DETAIL} textarea[aria-label="Notes"]`;
const DONE = `${DETAIL} button[aria-label="Done"]`;
const SUMMARY = '[data-testid="status-summary"]';

/** A fresh browser profile: its IndexedDB, as `fake-indexeddb/auto` provides it. */
function freshProfile() {
	globalThis.indexedDB = new IDBFactory();
}

/** Another tab of this profile; closed when the test ends. */
async function otherTab() {
	const folder = expectOk(await openFolder({ tables: todosTables }));
	cleanup.push(() => folder.close());
	return folder;
}

/** Mount the page; `close` unmounts it, which closes its folder. */
function mountPage() {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(PageHost, { target });
	let mounted = true;
	const close = () => {
		if (!mounted) return;
		mounted = false;
		void unmount(view);
		target.remove();
	};
	cleanup.push(close);
	return {
		target,
		close,
		get<T extends Element = HTMLInputElement>(selector: string): T {
			const element = target.querySelector(selector);
			if (element === null) throw new Error(`Nothing matches '${selector}'`);
			// SAFETY: callers choose T for the element matched by their selector.
			return element as T;
		},
		text: (selector: string) =>
			target.querySelector(selector)?.textContent?.trim(),
	};
}

/** Wait until `check` holds, letting saves, reads, and effects run. */
async function until(check: () => boolean, what: string) {
	for (let tries = 0; tries < 400; tries++) {
		flushSync();
		try {
			if (check()) return;
		} catch {
			// Not rendered yet.
		}
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** Mount the page and wait until it lists the todos. */
async function openPage() {
	const opened = mountPage();
	await until(
		() => opened.target.querySelector('[aria-label="Todos"]') !== null,
		'the list',
	);
	return opened;
}

const press = (element: Element) =>
	element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

/** The stored row of `id`, read through another handle. */
async function stored(id: string) {
	const folder = await otherTab();
	return folder.tables.todos.row(id);
}

/** Wait until the stored row of `id` satisfies `check`, as another tab reads it. */
async function untilStored(
	id: string,
	check: (row: Awaited<ReturnType<typeof stored>>) => boolean,
) {
	const folder = await otherTab();
	for (let tries = 0; tries < 400; tries++) {
		await folder.refresh();
		if (check(folder.tables.todos.row(id))) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${id} to be stored`);
}

/** Seed `todos/milk.md` and open the page on it. */
async function onMilk() {
	freshProfile();
	const folder = await otherTab();
	expectOk(
		await folder.tables.todos.create('milk', {
			fields: { title: 'Milk', done: false },
			body: 'Two litres',
		}),
	);
	resetUrl('http://localhost/?todo=milk');
	const opened = await openPage();
	await until(() => opened.get(TITLE).value === 'Milk', 'milk to open');
	return { ...opened, folder };
}

test('add, edit, complete, and delete persist across close and reopen', async () => {
	freshProfile();
	const first = await openPage();
	expect(first.text('[aria-label="Todos"]')).toContain('No todos yet');
	expect(first.target.querySelector('[data-testid="save-version"]')).toBeNull();
	expect(first.target.querySelector('[data-testid="sync"]')).toBeNull();
	expect(first.target.querySelector('[data-testid="connect-open"]')).toBeNull();

	type(first.get('[aria-label="New todo title"]'), 'Buy milk');
	flushSync();
	expect(first.get(SUMMARY).getAttribute('aria-label')).toContain(
		'Todo not added',
	);
	click(first.get(LIST), 'Add');
	await until(
		() => first.get(TITLE).value === 'Buy milk',
		'the new todo to open',
	);
	const id = page.url.searchParams.get('todo');
	if (id === null) throw new Error('The new todo did not open');

	type(first.get(TITLE), 'Buy oat milk');
	blur(first.get(TITLE));
	type(first.get<HTMLTextAreaElement>(NOTES), 'Two litres');
	blur(first.get(NOTES));
	press(first.get(DONE));
	await until(
		() =>
			first
				.get(SUMMARY)
				.getAttribute('aria-label')
				?.includes('Saved on this device') ?? false,
		'the edits to save',
	);
	expect(first.get(SUMMARY).getAttribute('aria-label')).toContain(
		'Saved on this device',
	);

	await untilStored(
		id,
		(row) =>
			row?.issues === null &&
			row.fields.title === 'Buy oat milk' &&
			row.fields.done,
	);
	first.close();

	const second = await openPage();
	await until(
		() => second.get(TITLE).value === 'Buy oat milk',
		'the todo to reopen',
	);
	expect(second.get<HTMLTextAreaElement>(NOTES).value).toBe('Two litres');
	expect(second.get(DONE).getAttribute('aria-checked')).toBe('true');

	click(second.get(DETAIL), 'Delete');
	await until(
		() => document.querySelector('[role="alertdialog"]') !== null,
		'the confirmation',
	);
	const dialog = document.querySelector('[role="alertdialog"]');
	if (dialog === null) throw new Error('The delete confirmation did not open');
	click(dialog, 'Delete');
	await until(() => page.url.searchParams.get('todo') === null, 'the delete');
	second.close();

	const third = await openPage();
	await until(
		() => third.text('[aria-label="Todos"]')?.includes('No todos yet') ?? false,
		'an empty list',
	);
	expect(await stored(id)).toBeUndefined();
});

test('a failed Add reports the error and keeps the typed title', async () => {
	freshProfile();
	const opened = await openPage();
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	type(opened.get('[aria-label="New todo title"]'), 'Buy tea');
	flushSync();
	click(opened.get(LIST), 'Add');
	await until(
		() => document.body.textContent?.includes('Could not add todo') ?? false,
		'the Add error',
	);
	expect(opened.get('[aria-label="New todo title"]').value).toBe('Buy tea');
	expect(opened.text('[aria-label="Todos"]')).toContain('No todos yet');
});

test('a failed Delete reports the error and keeps the todo open', async () => {
	const { get } = await onMilk();
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	click(get(DETAIL), 'Delete');
	await until(
		() => document.querySelector('[role="alertdialog"]') !== null,
		'the confirmation',
	);
	const dialog = document.querySelector('[role="alertdialog"]');
	if (dialog === null) throw new Error('The delete confirmation did not open');
	click(dialog, 'Delete');
	await until(
		() => document.body.textContent?.includes('Could not delete todo') ?? false,
		'the Delete error',
	);
	expect(page.url.searchParams.get('todo')).toBe('milk');
	expect(get(TITLE).value).toBe('Milk');
	expect((await stored('milk'))?.fields?.title).toBe('Milk');
});

test("another tab's change updates a clean todo without replacing its controls", async () => {
	const { get, folder } = await onMilk();
	const title = get(TITLE);
	const notes = get<HTMLTextAreaElement>(NOTES);

	expectOk(await folder.tables.todos.update('milk', { body: 'Three litres' }));
	await until(
		() => get<HTMLTextAreaElement>(NOTES).value === 'Three litres',
		'the other tab’s notes',
	);
	expect(get(TITLE)).toBe(title);
	expect(get(NOTES)).toBe(notes);
	expect(title.value).toBe('Milk');

	type(title, 'Oat milk');
	type(notes, 'Three litres, unsweetened');
	flushSync();
	expect(notes.value).toBe('Three litres, unsweetened');

	blur(title);
	await untilStored(
		'milk',
		(row) =>
			row?.issues === null &&
			row.fields.title === 'Oat milk' &&
			row.body === 'Three litres, unsweetened',
	);
	const saved = await stored('milk');
	expect(saved?.fields).toMatchObject({ title: 'Oat milk', done: false });
	expect(saved?.body).toBe('Three litres, unsweetened');
});

test('title typed here and done set elsewhere both survive', async () => {
	const { get, folder } = await onMilk();
	const title = get(TITLE);
	type(title, 'Oat milk');
	flushSync();
	expectOk(
		await folder.tables.todos.update('milk', { fields: { done: true } }),
	);
	expect(title.value).toBe('Oat milk');
	await untilStored(
		'milk',
		(row) =>
			row?.issues === null &&
			row.fields.title === 'Oat milk' &&
			row.fields.done,
	);
	const saved = await stored('milk');
	expect(saved?.fields).toMatchObject({ title: 'Oat milk', done: true });
	expect(saved?.body).toBe('Two litres');
});

test('rapid typing saves the latest title', async () => {
	const { get } = await onMilk();
	type(get(TITLE), 'Oat milk');
	flushSync();
	expect(get(TITLE).value).toBe('Oat milk');
	type(get(TITLE), 'Almond milk');
	flushSync();
	expect(get(TITLE).value).toBe('Almond milk');
	await untilStored(
		'milk',
		(row) => row?.issues === null && row.fields.title === 'Almond milk',
	);
});

test('a deleted todo shows absence even when its editor was already open', async () => {
	freshProfile();
	resetUrl('http://localhost/?todo=ghost');
	const ghost = await openPage();
	await until(
		() => ghost.text(DETAIL)?.includes('This todo is no longer here') ?? false,
		'the missing todo',
	);
	ghost.close();
	const { target, get, text, folder } = await onMilk();
	expect(get(TITLE).value).toBe('Milk');
	expectOk(await folder.tables.todos.delete('milk'));
	await until(
		() => text(DETAIL)?.includes('This todo is no longer here') ?? false,
		'the deletion observation',
	);
	expect(target.querySelector(TITLE)).toBeNull();
	expect(
		target.querySelector('button[aria-label="Complete Milk"]:not([disabled])'),
	).toBeNull();
	expect(await stored('milk')).toBeUndefined();
});

test('a failed title stays visible and Save again writes it', async () => {
	const { get } = await onMilk();
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});

	type(get(TITLE), 'Oat milk');
	blur(get(TITLE));
	await until(
		() => get(DETAIL).textContent?.includes('Not saved:') ?? false,
		'the unsaved title notice',
	);
	expect(get(DETAIL).textContent).toContain('Copy');
	expect(get(TITLE).value).toBe('Oat milk');
	expect((await stored('milk'))?.fields?.title).toBe('Milk');
	IDBObjectStore.prototype.put = put;
	click(get(DETAIL), 'Save again');
	await untilStored(
		'milk',
		(row) => row?.issues === null && row.fields.title === 'Oat milk',
	);
	await until(
		() => !get(DETAIL).textContent?.includes('Not saved:'),
		'the notice to clear',
	);
});

test('Discard returns a failed title to the disk value', async () => {
	const { get } = await onMilk();
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	type(get(TITLE), 'Oat milk');
	await until(
		() => get(DETAIL).textContent?.includes('Not saved:') ?? false,
		'the unsaved title notice',
	);
	click(get(DETAIL), 'Discard');
	await until(() => get(TITLE).value === 'Milk', 'the disk title to show');
	expect(get(DETAIL).textContent).not.toContain('Not saved:');
	expect((await stored('milk'))?.fields?.title).toBe('Milk');
	IDBObjectStore.prototype.put = put;
});

test('a failed Done toggle reports the error and follows the saved value', async () => {
	const { get } = await onMilk();
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	press(get(DONE));
	await until(
		() => document.body.textContent?.includes('Could not update todo') ?? false,
		'the Done error',
	);
	expect(get(DONE).getAttribute('aria-checked')).toBe('false');
	expect((await stored('milk'))?.fields?.done).toBe(false);
	expect(get(DETAIL).textContent).not.toContain('Not saved:');
	IDBObjectStore.prototype.put = put;
});

test('a failed list-row toggle reports the error and follows the saved value', async () => {
	const { get } = await onMilk();
	setWide(true);
	cleanup.push(() => setWide(false));
	flushSync();
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	press(get('button[aria-label="Complete Milk"]'));
	await until(
		() => document.body.textContent?.includes('Could not update todo') ?? false,
		'the list-row error',
	);
	expect(
		get('button[aria-label="Complete Milk"]').getAttribute('aria-checked'),
	).toBe('false');
	expect((await stored('milk'))?.fields?.done).toBe(false);
	expect(get(LIST).textContent).not.toContain('Not saved:');
	IDBObjectStore.prototype.put = put;
});

test('a new title not added does not prompt before a browser reload', async () => {
	freshProfile();
	const opened = await openPage();
	type(opened.get('[aria-label="New todo title"]'), 'Buy tea');
	flushSync();
	expect(opened.get(SUMMARY).getAttribute('aria-label')).toContain(
		'Todo not added',
	);
	expect(
		window.dispatchEvent(new Event('beforeunload', { cancelable: true })),
	).toBe(true);
	expect(navigation.leave()).toBe(false);
	expect(opened.get('[aria-label="New todo title"]').value).toBe('Buy tea');
});

test('a row that does not fit is listed with its source, and an edit keeps unnamed fields', async () => {
	freshProfile();
	const folder = await otherTab();
	expectOk(
		await folder.write(
			'todos/odd.md',
			'---\ntitle: Odd\ndone: soon\n---\nNotes\n',
		),
	);
	expectOk(
		await folder.write(
			'todos/extra.md',
			'---\ntitle: Extra\ndone: false\nowner: sam\n---\n',
		),
	);
	const opened = await openPage();
	await until(
		() => opened.target.querySelector('[aria-label="Needs repair"]') !== null,
		'the repair list',
	);
	expect(opened.text('[aria-label="Needs repair"]')).toContain('todos/odd.md');

	click(opened.get('[aria-label="Needs repair"]'), 'Show');
	await until(
		() => opened.target.querySelector('[data-testid="needs-repair"]') !== null,
		'the source',
	);
	expect(opened.text(`${DETAIL} pre`)).toBe(
		'---\ntitle: Odd\ndone: soon\n---\nNotes',
	);

	press(opened.get('[data-todo="todos/extra.md"]'));
	await until(() => opened.get(TITLE).value === 'Extra', 'extra to open');
	type(opened.get(TITLE), 'Extra, renamed');
	blur(opened.get(TITLE));
	await untilStored(
		'extra',
		(row) => row?.issues === null && row.fields.title === 'Extra, renamed',
	);
	const saved = await stored('extra');
	expect(saved?.fields).toEqual({
		title: 'Extra, renamed',
		done: false,
		owner: 'sam',
	});
	expect(folder.file('todos/odd.md')?.data).toBe(
		'---\ntitle: Odd\ndone: soon\n---\nNotes\n',
	);
});

test('a failed storage check opens nothing, and Try again checks again', async () => {
	freshProfile();
	const database = indexedDB;
	let blocked = true;
	// SAFETY: the test only calls `open` and restores the full factory afterward.
	globalThis.indexedDB = {
		open: (name: string, version?: number) => {
			if (blocked)
				throw new DOMException('Storage access is blocked', 'SecurityError');
			return database.open(name, version);
		},
	} as IDBFactory;
	cleanup.push(() => {
		globalThis.indexedDB = database;
	});
	const opened = mountPage();
	await until(
		() =>
			opened.text('[role="alert"]')?.includes('Storage access is blocked') ??
			false,
		'the refusal',
	);
	expect(opened.target.querySelector(LIST)).toBeNull();
	expect(await database.databases()).toEqual([]);

	blocked = false;
	press(button(opened.target, 'Try again'));
	await until(
		() => opened.target.querySelector('[aria-label="Todos"]') !== null,
		'the local list',
	);
});
