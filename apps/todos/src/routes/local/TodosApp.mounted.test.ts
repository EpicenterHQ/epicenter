/**
 * Local Todos Mounted Tests
 *
 * Mounts the real Todos page in jsdom, as the layout mounts it, over an
 * in-memory IndexedDB with no OPFS: the page chooses this browser's local
 * folder, `openFolder({ tables: todosTables })`, and opens it through
 * `<FolderApp>`. A second handle of the same profile stands in for
 * another tab. jsdom matches no media query, so the view lays out as on a
 * narrow screen.
 *
 * Key behaviors:
 * - Add, edit, complete, and delete persist across close and reopen; close
 *   saves typing that still waited for its pause
 * - Another tab's committed change updates clean controls; unsaved source
 *   stays pinned and later local whole-source publication wins
 * - A failed save keeps the typing and offers Try again; the header says
 *   Saved on this device only once it saved
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
const STATUS = '[data-testid="write-status"]';
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
			return element as unknown as T;
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
	return expectOk(await folder.tables.todos.get(id));
}

/** Wait until the stored row of `id` satisfies `check`, as another tab reads it. */
async function untilStored(
	id: string,
	check: (row: Awaited<ReturnType<typeof stored>>) => boolean,
) {
	const folder = await otherTab();
	for (let tries = 0; tries < 400; tries++) {
		if (check(expectOk(await folder.tables.todos.get(id)))) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${id} to be stored`);
}

/** Seed `todos/milk.md` and open the page on it. */
async function onMilk() {
	freshProfile();
	const folder = await otherTab();
	expectOk(
		await folder.tables.todos.set('milk', {
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
	const id = page.url.searchParams.get('todo')!;

	type(first.get(TITLE), 'Buy oat milk');
	blur(first.get(TITLE));
	type(first.get<HTMLTextAreaElement>(NOTES), 'Two litres');
	blur(first.get(NOTES));
	press(first.get(DONE));
	await until(
		() => first.text(STATUS) === 'Saved on this device',
		'the edits to save',
	);
	expect(first.get(SUMMARY).getAttribute('aria-label')).toContain(
		'Saved on this device',
	);

	// Typed and closed before its pause: close leaves this input unsaved.
	type(first.get(TITLE), 'Buy oat milk, cold');
	first.close();
	await untilStored(id, (row) => row?.fields?.title === 'Buy oat milk');

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
	click(document.querySelector('[role="alertdialog"]')!, 'Delete');
	await until(() => page.url.searchParams.get('todo') === null, 'the delete');
	second.close();

	const third = await openPage();
	await until(
		() => third.text('[aria-label="Todos"]')?.includes('No todos yet') ?? false,
		'an empty list',
	);
	expect(await stored(id)).toBeUndefined();
});

test("another tab's change updates a clean todo without replacing its controls", async () => {
	const { get, folder } = await onMilk();
	const title = get(TITLE);
	const notes = get<HTMLTextAreaElement>(NOTES);

	const from = expectOk(await folder.tables.todos.get('milk'))!;
	expectOk(await folder.tables.todos.set('milk', { body: 'Three litres' }));
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
	await until(
		() => get(STATUS).textContent?.trim() === 'Saved on this device',
		'the save',
	);
	const saved = await stored('milk');
	expect(saved?.fields).toMatchObject({ title: 'Oat milk', done: false });
	expect(saved?.body).toBe('Three litres, unsweetened');
});

test('a local whole-source publication wins after another tab changes the file', async () => {
	const { get, folder } = await onMilk();
	const title = get(TITLE);
	const notes = get<HTMLTextAreaElement>(NOTES);
	type(title, 'Oat milk');
	flushSync();
	expectOk(await folder.tables.todos.set('milk', { body: 'Three litres' }));
	expect(title.value).toBe('Oat milk');
	expect(notes.value).toBe('Two litres');
	await until(
		() => get(STATUS).textContent?.trim() === 'Saved on this device',
		'the local publication',
	);
	expect(get(TITLE)).toBe(title);
	expect(get(NOTES)).toBe(notes);
	const saved = await stored('milk');
	expect(saved?.fields).toMatchObject({ title: 'Oat milk', done: false });
	expect(saved?.body).toBe('Two litres');
});

test('the list labels a todo by its saved title while its checkbox shows what is held', async () => {
	const { get, target } = await onMilk();
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	type(get(TITLE), 'Oat milk');
	press(get(DONE));
	await until(
		() => target.querySelector('[aria-label="Reopen Milk"]') !== null,
		'the list to show the held done',
	);
	expect(target.querySelector('[data-todo="todos/milk.md"]')?.textContent).toBe(
		'Milk',
	);
	expect((await stored('milk'))?.fields).toMatchObject({
		title: 'Milk',
		done: false,
	});
});

test('a missing todo shows absence, while an acquired todo keeps its usable text after deletion', async () => {
	freshProfile();
	resetUrl('http://localhost/?todo=ghost');
	const ghost = await openPage();
	await until(
		() => ghost.text(DETAIL)?.includes('This todo is no longer here') ?? false,
		'the missing todo',
	);
	ghost.close();
	const { get, text, folder } = await onMilk();
	const title = get(TITLE);
	expectOk(await folder.tables.todos.delete('milk'));
	await until(
		() => text(DETAIL)?.includes('Could not read the latest todo') ?? false,
		'the deletion observation',
	);
	expect(get(TITLE)).toBe(title);
	expect(title.value).toBe('Milk');
	type(title, 'Recreated milk');
	await until(
		() => get(STATUS).textContent?.trim() === 'Saved on this device',
		'the recreation',
	);
	expect((await stored('milk'))?.fields?.title).toBe('Recreated milk');
});

test('a failed save keeps the typing and offers Try again', async () => {
	const { get, text } = await onMilk();
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
		() => text(STATUS)?.startsWith('Not saved') ?? false,
		'the failure',
	);
	expect(text(STATUS)).toContain('QuotaExceededError');
	expect(get(TITLE).value).toBe('Oat milk');
	expect(get(SUMMARY).getAttribute('aria-label')).toContain('Not saved');

	IDBObjectStore.prototype.put = put;
	click(get(STATUS), 'Try again');
	await until(() => text(STATUS) === 'Saved on this device', 'the retry');
	expect(get(SUMMARY).getAttribute('aria-label')).toContain(
		'Saved on this device',
	);
	expect((await stored('milk'))?.fields?.title).toBe('Oat milk');
});

test('rejected notes explain the refusal without claiming a save failure', async () => {
	const { get, text } = await onMilk();
	const before = get<HTMLTextAreaElement>(NOTES).value;
	type(get(NOTES), 'Rejected\0notes');
	await until(
		() => document.body.textContent?.includes('NUL character') ?? false,
		'the input refusal',
	);
	expect(document.body.textContent).toContain('That change was not made');
	await until(
		() => get<HTMLTextAreaElement>(NOTES).value === before,
		'the notes to show accepted content',
	);
	expect(get<HTMLTextAreaElement>(NOTES).value).toBe(before);
	expect(text(STATUS)).toBe('Saved on this device');
	expect((await stored('milk'))?.body).toBe(before);
	// The next valid input still enters the ordinary autosave path.
	type(get(NOTES), 'Accepted notes');
	await until(() => text(STATUS) === 'Saved on this device', 'the valid save');
	expect((await stored('milk'))?.body).toBe('Accepted notes');
});

test('leaving with a failed draft asks before unloading and does not save it on unmount', async () => {
	const { get, text, close } = await onMilk();
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
		() => text(STATUS)?.startsWith('Not saved') ?? false,
		'the failure',
	);
	const leaving = new Event('beforeunload', { cancelable: true });
	expect(window.dispatchEvent(leaving)).toBe(false);
	close();
	expect((await stored('milk'))?.fields?.title).toBe('Milk');
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
		await folder.files.write(
			'todos/odd.md',
			'---\ntitle: Odd\ndone: soon\n---\nNotes\n',
		),
	);
	expectOk(
		await folder.files.write(
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
	await until(() => opened.text(STATUS) === 'Saved on this device', 'the save');
	const saved = await stored('extra');
	expect(saved?.fields).toEqual({
		title: 'Extra, renamed',
		done: false,
		owner: 'sam',
	});
	expect((await stored('odd'))?.text).toBe(
		'---\ntitle: Odd\ndone: soon\n---\nNotes\n',
	);
});

test('a failed storage check opens nothing, and Try again checks again', async () => {
	freshProfile();
	const database = indexedDB;
	let blocked = true;
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
