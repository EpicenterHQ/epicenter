/**
 * Todo Detail Mounted Tests
 *
 * Mounts the real list and the real `TodoDetail` as `TodosView` lays them
 * out on a wide screen, with their real `TodoRow`, `FileNameBar`, and
 * `@epicenter/ui` controls, in jsdom inside the query client the folder's
 * scope provides, over the real Todos store (`createTodos`) and a real
 * browser folder on the in-memory OPFS stand-in. Typing goes through the
 * DOM, into the shared `Input` and `Textarea` and their function bindings;
 * another writer changes the file through `folder.files`.
 *
 * Key behaviors:
 * - Typing a title or notes changes the cache at once, so the list shows it
 *   while the view's own write mutation saves it. Each todo gets its own
 *   view, and each input saves at its own path
 * - A write that meets a change made elsewhere rolls the input back to the
 *   file and reports what was lost
 * - Returning to the window shows another writer's change
 * - A malformed todo shows under "Needs repair"; opened, it shows its issues
 *   and its text. Save writes the typed text, keeping the file's CRLF, and
 *   then the detail shows its fields. A repair over a file changed elsewhere
 *   writes nothing, reports the typed text, and keeps it in the field
 * - A title input keeps its value well formed, so what is written is what
 *   is shown
 * - Notes show LF and keep the file's CRLF
 * - Completion from the list and the detail keep notes and undeclared keys
 * - Renaming the file keeps the todo open under its new name
 *
 * jsdom implements no layout, focus, selection, IME, or `inert`. Toasts,
 * the clipboard, and the confirmation dialog are not exercised.
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import '../../lib/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { parseRow } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
} from '../../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from '../../lib/definition.js';
import { quiet } from '../../lib/query.test-support.js';
import type { WriteFailure } from '../../lib/session.js';
import { click, type } from '../../lib/svelte-dom.test-support.js';
import type { Todos } from '../../lib/todos.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createTodos } = await import('../../lib/todos.svelte.ts');
const { default: TodoDetailHost } = await import(
	'./fixtures/TodoDetailHost.svelte'
);

const ROW = (title: string) => `---\ntitle: ${title}\ndone: false\n---\n`;
let count = 0;
const cleanup: (() => Promise<unknown> | void)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** The real store over a fresh browser folder, with the list and the detail mounted over it. */
async function setup() {
	const storage = createTestStorage();
	const folder = expectOk(
		await openFolder({
			id: `todo-detail-mounted-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				...browserStorage(storage),
			},
		}),
	);
	const failures: WriteFailure[] = [];
	const todos: Todos = createTodos(folder, {
		onWriteFailed: (failure) => failures.push(failure),
	});
	cleanup.push(() => todos.close());
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(TodoDetailHost, { target, props: { todos } });
	flushSync();
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	await settle(todos);
	async function text(path: string) {
		const { data } = await folder.files.read(path);
		return data === null ? undefined : new TextDecoder().decode(data.bytes);
	}
	return {
		todos,
		failures,
		target,
		detail: () => target.querySelector('[data-host="detail"]')!,
		list: () => target.querySelector('[data-host="list"]')!,
		find<T extends Element = HTMLTextAreaElement>(selector: string) {
			return target.querySelector(selector) as T | null;
		},
		get<T extends Element = HTMLTextAreaElement>(selector: string): T {
			const element = target.querySelector(selector);
			if (element === null) throw new Error(`Nothing matches '${selector}'`);
			return element as unknown as T;
		},
		text,
		/** The row the file at `path` reads as, undeclared keys included. */
		async reading(
			path: string,
		): Promise<{ fields: Record<string, unknown>; body: string }> {
			return expectOk(
				parseRow(todosDefinition.tables.todos, (await text(path))!),
			);
		},
		/** Another writer replaces the file. */
		async overwrite(path: string, content: string) {
			expectOk(await folder.files.overwrite(path, content));
		},
	};
}

const TITLE = '[data-host="detail"] input[aria-label="Title"]';
const NOTES = '[data-host="detail"] textarea[aria-label="Notes"]';
const DONE = '[data-host="detail"] button[aria-label="Done"]';
/** A malformed todo's text, for repair. */
const REPAIR = '[data-host="detail"] textarea[aria-label^="Text of"]';

/** Let writes, reads, and effects run, then render. */
async function settle(todos: Todos) {
	await quiet(todos);
	flushSync();
	await Bun.sleep(0);
	flushSync();
}

/** Wait for something the test did not request directly, then render. */
async function eventually(done: () => boolean) {
	for (let waited = 0; waited < 400 && !done(); waited++) {
		await Bun.sleep(5);
		flushSync();
	}
	flushSync();
}

/** Deliver a click to an element, attached or not. */
function press(element: Element) {
	element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** The list's labels, in order. */
function listed(list: Element) {
	return [...list.querySelectorAll('[data-todo]')].map((row) =>
		row.textContent?.trim(),
	);
}

/** Open the todo at `path` from the list. */
async function openTodo(todos: Todos, target: Element, path: string) {
	const row = [
		...target.querySelectorAll('[data-host="list"] [data-todo]'),
	].find((candidate) => candidate.getAttribute('data-todo') === path);
	if (row === undefined) throw new Error(`The list does not show ${path}`);
	press(row);
	await settle(todos);
}

/** Add a todo through the list and show it, as the list does; answers its path. */
async function addTodo(todos: Todos, target: Element, title: string) {
	const opened = () =>
		target.querySelector('[data-host="detail"]')?.getAttribute('data-open');
	const before = opened();
	type(target.querySelector('[aria-label="New todo title"]'), title);
	flushSync();
	click(target.querySelector('[data-host="list"]')!, 'Add');
	await settle(todos);
	await eventually(() => opened() != null && opened() !== before);
	return `todos/${opened()}.md`;
}

/** Read every listing again, as Check again does. */
async function reread(todos: Todos) {
	await todos.refresh();
	await settle(todos);
}

test('typing changes the cache at once, so the list shows it, and each todo saves at its own path', async () => {
	const { todos, target, get, list, reading } = await setup();
	const pathA = await addTodo(todos, target, 'A');
	const pathB = await addTodo(todos, target, 'B');

	await openTodo(todos, target, pathA);
	const title = get<HTMLInputElement>(TITLE);
	expect(title.value).toBe('A');
	type(title, 'A typed');
	flushSync();
	// The list reads the same cache: it shows the typing before the write lands.
	expect(listed(list())).toContain('A typed');
	await settle(todos);
	expect(get('[data-testid="write-status"]').textContent).toContain(
		`Saved to ${pathA}`,
	);

	// B's view is a new one.
	await openTodo(todos, target, pathB);
	expect(get<HTMLInputElement>(TITLE)).not.toBe(title);
	expect(get<HTMLInputElement>(TITLE).value).toBe('B');
	type(get<HTMLInputElement>(TITLE), 'B typed');
	type(get(NOTES), 'B notes\n');
	await settle(todos);

	await openTodo(todos, target, pathA);
	expect(get<HTMLInputElement>(TITLE).value).toBe('A typed');
	expect(get(NOTES).value).toBe('');
	expect(await reading(pathA)).toEqual({
		fields: { title: 'A typed', done: false },
		body: '',
	});
	expect(await reading(pathB)).toEqual({
		fields: { title: 'B typed', done: false },
		body: 'B notes\n',
	});
});

test('a write that meets a change made elsewhere rolls the input back to the file and reports what was lost', async () => {
	const { todos, target, get, list, failures, overwrite, text } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	const theirs = ROW('Milk from the shop');
	await overwrite(path, theirs);

	type(get<HTMLInputElement>(TITLE), 'Oat milk');
	await settle(todos);
	await eventually(() => failures.length > 0);
	await settle(todos);
	expect(failures).toMatchObject([{ path, error: { name: 'Conflict' } }]);
	expect(failures[0]!.lost).toContain('title: Oat milk');
	expect(get<HTMLInputElement>(TITLE).value).toBe('Milk from the shop');
	expect(listed(list())).toEqual(['Milk from the shop']);
	expect(await text(path)).toBe(theirs);

	// Typing again writes on top of what is there now.
	type(get<HTMLInputElement>(TITLE), 'Oat milk');
	await settle(todos);
	expect(failures).toHaveLength(1);
	expect(await text(path)).toBe(ROW('Oat milk'));
});

test("returning to the window shows another writer's change", async () => {
	const { todos, target, get, list, overwrite } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	await overwrite(path, ROW('Milk, edited elsewhere'));
	await settle(todos);
	// Nothing follows the folder's change reports while the window has focus.
	expect(get<HTMLInputElement>(TITLE).value).toBe('Milk');

	// The person comes back to the page.
	document.dispatchEvent(new Event('visibilitychange'));
	await eventually(
		() => get<HTMLInputElement>(TITLE).value === 'Milk, edited elsewhere',
	);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Milk, edited elsewhere');
	expect(listed(list())).toEqual(['Milk, edited elsewhere']);
});

test('a malformed todo shows its issues and text; Save writes the typed text, keeping CRLF, and then the detail shows its fields', async () => {
	const { todos, get, find, list, text, reading } = await setup();
	const broken = '---\r\ntitle: *missing\r\n---\r\n';
	expectOk(await todos.folder.files.create('todos/bad.md', broken));
	await reread(todos);
	const repairs = () => list().querySelector('[aria-label="Needs repair"]');
	expect(repairs()?.textContent).toContain('todos/bad.md');

	click(repairs()!, 'Repair');
	await settle(todos);
	expect(find('[data-testid="needs-repair"]')?.textContent).toContain(
		'Needs repair',
	);
	expect(find(TITLE)).toBeNull();
	const field = get(REPAIR);
	expect(field.value).toBe(broken.replace(/\r\n/g, '\n'));

	// Text that still does not parse is written as typed, and still needs repair.
	type(field, '---\ntitle: Bread\ndone: soon\n---\n');
	flushSync();
	click(get('[data-host="detail"]'), 'Save');
	await settle(todos);
	expect(await text('todos/bad.md')).toBe(
		'---\r\ntitle: Bread\r\ndone: soon\r\n---\r\n',
	);
	expect(get(REPAIR).value).toBe('---\ntitle: Bread\ndone: soon\n---\n');

	type(get(REPAIR), ROW('Fixed'));
	flushSync();
	click(get('[data-host="detail"]'), 'Save');
	await settle(todos);
	expect(await text('todos/bad.md')).toBe(ROW('Fixed').replace(/\n/g, '\r\n'));
	expect(repairs()).toBeNull();
	expect(find(REPAIR)).toBeNull();
	expect(get<HTMLInputElement>(TITLE).value).toBe('Fixed');
	type(get<HTMLInputElement>(TITLE), 'Live');
	press(get<HTMLButtonElement>(DONE));
	await settle(todos);
	expect(await reading('todos/bad.md')).toEqual({
		fields: { title: 'Live', done: true },
		body: '',
	});
});

test('a repair over a file changed elsewhere writes nothing, reports the typed text, and keeps it in the field', async () => {
	const { todos, target, get, list, failures, overwrite, text } = await setup();
	expectOk(await todos.folder.files.create('todos/bad.md', 'not a todo'));
	await reread(todos);
	click(list().querySelector('[aria-label="Needs repair"]')!, 'Repair');
	await settle(todos);
	await overwrite('todos/bad.md', 'changed elsewhere');

	type(get(REPAIR), ROW('Mine'));
	flushSync();
	click(get('[data-host="detail"]'), 'Save');
	await settle(todos);
	await eventually(() => failures.length > 0);
	expect(failures).toMatchObject([
		{ path: 'todos/bad.md', error: { name: 'Conflict' }, lost: ROW('Mine') },
	]);
	expect(await text('todos/bad.md')).toBe('changed elsewhere');
	expect(get(REPAIR).value).toBe(ROW('Mine'));
	expect(target.querySelector(TITLE)).toBeNull();
});

test('a title input keeps its value well formed, so what is written is what is shown', async () => {
	const { todos, target, get, failures, reading } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	const title = get<HTMLInputElement>(TITLE);
	title.value = 'Oat \uD800';
	expect(title.value.isWellFormed()).toBe(false);
	title.dispatchEvent(new window.Event('input', { bubbles: true }));
	await settle(todos);
	expect(failures).toEqual([]);
	expect(title.value).toBe('Oat �');
	expect((await reading(path)).fields.title).toBe('Oat �');
});

test("notes show LF, and typing in them keeps the file's CRLF and undeclared keys", async () => {
	const { todos, target, get, reading } = await setup();
	const crlf =
		'---\r\ntitle: Milk\r\ndone: false\r\nowner: sam\r\n---\r\nOne\r\nTwo\r\n';
	expectOk(await todos.folder.files.create('todos/crlf.md', crlf));
	await reread(todos);
	await openTodo(todos, target, 'todos/crlf.md');
	const notes = get(NOTES);
	expect(notes.value).toBe('One\nTwo\n');

	type(notes, 'One\nTwo\nThree\n');
	await settle(todos);
	// The body keeps the file's CRLF; the frontmatter is written canonically.
	expect(await reading('todos/crlf.md')).toEqual({
		fields: { title: 'Milk', done: false, owner: 'sam' },
		body: 'One\r\nTwo\r\nThree\r\n',
	});
});

test('completion from the list and from the detail keeps notes and undeclared keys', async () => {
	const { todos, target, get, list, reading } = await setup();
	const path = 'todos/milk.md';
	expectOk(
		await todos.folder.files.create(
			path,
			'---\ntitle: Milk\ndone: false\nowner: keep-me\n---\nCurrent notes.',
		),
	);
	await reread(todos);
	await openTodo(todos, target, path);
	const completion = () =>
		list().querySelector<HTMLButtonElement>('[role="checkbox"]')!;

	press(completion());
	flushSync();
	expect(completion().getAttribute('aria-checked')).toBe('true');
	expect(get<HTMLButtonElement>(DONE).getAttribute('aria-checked')).toBe(
		'true',
	);
	await settle(todos);
	expect(await reading(path)).toEqual({
		fields: { title: 'Milk', done: true, owner: 'keep-me' },
		body: 'Current notes.',
	});
	press(get<HTMLButtonElement>(DONE));
	await settle(todos);
	expect(completion().getAttribute('aria-checked')).toBe('false');
	expect(await reading(path)).toEqual({
		fields: { title: 'Milk', done: false, owner: 'keep-me' },
		body: 'Current notes.',
	});
});

test('renaming the file keeps the todo open under its new name', async () => {
	const { todos, target, get, text } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	type(get<HTMLInputElement>('[data-host="detail"] form input'), 'milk');
	flushSync();
	click(get('[data-host="detail"]'), 'Rename file');
	await settle(todos);
	await eventually(
		() => get('[data-host="detail"]').getAttribute('data-open') === 'milk',
	);
	expect(await text(path)).toBeUndefined();
	expect(await text('todos/milk.md')).toContain('title: Milk');
	expect(get<HTMLInputElement>(TITLE).value).toBe('Milk');
});
