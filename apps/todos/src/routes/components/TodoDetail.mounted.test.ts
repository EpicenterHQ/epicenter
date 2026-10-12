/**
 * Todo Detail Mounted Tests
 *
 * Mounts the real detail pane (`Detail`, which `TodosView` renders) and the
 * real list, with their real `TodoDetail`, `FileView`, `TodoRow`,
 * `FileNameBar`, and `@epicenter/ui` controls, in jsdom inside the query
 * client the layout provides, over the real Todos owner (`startTodos`) and
 * a real browser folder on the in-memory OPFS stand-in. Typing goes through
 * the DOM, into the shared `Input` and `Textarea` and their function
 * bindings; another writer changes the file through `folder.files`.
 *
 * Key behaviors:
 * - Typing a title or notes changes the cache at once, so the list shows it
 *   while the view's own write mutation saves it. Each todo gets its own
 *   view, and each input saves at its own path
 * - A write that meets a change made elsewhere rolls the input back to the
 *   file and reports what was lost
 * - Returning to the window shows another writer's change
 * - Files opens a todo's complete text and the list opens its fields. A
 *   malformed todo shows as needing repair and opens as text that says why;
 *   repaired there, Open as todo shows its fields
 * - A title input keeps its value well formed, so what is written is what
 *   is shown
 * - Notes and Files' text show LF and keep the file's CRLF
 * - While a todo is open as text, its list checkbox waits; opened as a
 *   todo, completion from the list and the detail keep its notes and
 *   undeclared keys
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
import { click, type } from '../../lib/svelte-dom.test-support.js';
import type { Todos, WriteFailure } from '../../lib/todos.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { startTodos } = await import('../../lib/todos.svelte.ts');
const { default: TodoDetailHost } = await import(
	'./fixtures/TodoDetailHost.svelte'
);

const ROW = (title: string) => `---\ntitle: ${title}\ndone: false\n---\n`;
let count = 0;
const cleanup: (() => Promise<unknown> | void)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** The real owner over a fresh browser folder, with the list and the detail mounted over it. */
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
	const todos: Todos = startTodos(folder, {
		onWriteFailed: (failure) => failures.push(failure),
	});
	cleanup.push(() => todos.close());
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(TodoDetailHost, { target, props: { list: true } });
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
/** Files' complete-text editor, whatever the file. */
const CONTENTS = '[data-host="detail"] textarea[aria-label^="Contents of"]';

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

/** Add a todo through the app and show it; answers its path. */
async function addTodo(todos: Todos, title: string) {
	const created = expectOk(await todos.create(title));
	await settle(todos);
	return created.path;
}

test('typing changes the cache at once, so the list shows it, and each todo saves at its own path', async () => {
	const { todos, get, list, reading } = await setup();
	const pathA = await addTodo(todos, 'A');
	const pathB = await addTodo(todos, 'B');

	todos.select(pathA, 'todos');
	await settle(todos);
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
	todos.select(pathB, 'todos');
	await settle(todos);
	expect(get<HTMLInputElement>(TITLE)).not.toBe(title);
	expect(get<HTMLInputElement>(TITLE).value).toBe('B');
	type(get<HTMLInputElement>(TITLE), 'B typed');
	type(get(NOTES), 'B notes\n');
	await settle(todos);

	todos.select(pathA, 'todos');
	await settle(todos);
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
	const { todos, get, list, failures, overwrite, text } = await setup();
	const path = await addTodo(todos, 'Milk');
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
	const { todos, get, list, overwrite } = await setup();
	const path = await addTodo(todos, 'Milk');
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

test('Files opens the complete text and the list opens fields; a malformed todo shows as needing repair, opens as text that says why, and repaired there, Open as todo shows its fields', async () => {
	const { todos, target, get, find, list, text, reading } = await setup();
	expectOk(await todos.folder.files.create('todos/milk.md', ROW('Milk')));
	const broken = '---\ntitle: *missing\n---\n';
	expectOk(await todos.folder.files.create('todos/bad.md', broken));
	await todos.queryClient.invalidateQueries({ queryKey: ['todos'] });
	await settle(todos);
	expect(
		list().querySelector('[aria-label="Needs repair"]')?.textContent,
	).toContain('todos/bad.md');

	// The same file, from each surface.
	todos.select('todos/milk.md', 'files');
	await settle(todos);
	expect(get(CONTENTS).value).toBe(ROW('Milk'));
	expect(find(TITLE)).toBeNull();
	todos.select('todos/milk.md', 'todos');
	await settle(todos);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Milk');
	expect(find(CONTENTS)).toBeNull();

	// A malformed row opened as a todo says it needs repair, and offers its text.
	todos.select('todos/bad.md', 'todos');
	await settle(todos);
	expect(find('[data-testid="needs-repair"]')?.textContent).toContain(
		'Needs repair',
	);
	expect(find(TITLE)).toBeNull();
	click(target, 'Repair as text');
	await settle(todos);
	expect(todos.selected).toEqual({ path: 'todos/bad.md', as: 'repair' });
	expect(find('[data-testid="row-issues"]')?.textContent).toContain(
		'Needs repair',
	);
	const contents = get(CONTENTS);
	expect(contents.value).toBe(broken);
	const open = () =>
		[...target.querySelectorAll('button')].find(
			(button) => button.textContent?.trim() === 'Open as todo',
		)!;
	expect(open().disabled).toBe(true);

	// Repaired as text, it is written as typed and offers Open as todo.
	type(contents, ROW('Fixed'));
	await settle(todos);
	expect(await text('todos/bad.md')).toBe(ROW('Fixed'));
	expect(find('[data-testid="row-issues"]')).toBeNull();
	expect(open().disabled).toBe(false);
	expect(list().querySelector('[aria-label="Needs repair"]')).toBeNull();

	click(target, 'Open as todo');
	await settle(todos);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Fixed');
	type(get<HTMLInputElement>(TITLE), 'Live');
	type(get(NOTES), 'live notes\n');
	press(get<HTMLButtonElement>(DONE));
	await settle(todos);
	expect(await reading('todos/bad.md')).toEqual({
		fields: { title: 'Live', done: true },
		body: 'live notes\n',
	});
});

test('a title input keeps its value well formed, so what is written is what is shown', async () => {
	const { todos, get, failures, reading } = await setup();
	const path = await addTodo(todos, 'Milk');
	const title = get<HTMLInputElement>(TITLE);
	title.value = 'Oat \uD800';
	expect(title.value.isWellFormed()).toBe(false);
	title.dispatchEvent(new window.Event('input', { bubbles: true }));
	await settle(todos);
	expect(failures).toEqual([]);
	expect(title.value).toBe('Oat �');
	expect((await reading(path)).fields.title).toBe('Oat �');
});

test("notes and Files' text show LF, and typing in them keeps the file's CRLF and undeclared keys", async () => {
	const { todos, target, get, find, text, reading } = await setup();
	const crlf =
		'---\r\ntitle: Milk\r\ndone: false\r\nowner: sam\r\n---\r\nOne\r\nTwo\r\n';
	expectOk(await todos.folder.files.create('todos/crlf.md', crlf));
	await todos.queryClient.invalidateQueries({ queryKey: ['todos'] });
	todos.select('todos/crlf.md', 'todos');
	await settle(todos);
	const notes = get(NOTES);
	expect(notes.value).toBe('One\nTwo\n');

	type(notes, 'One\nTwo\nThree\n');
	await settle(todos);
	// The body keeps the file's CRLF; the frontmatter is written canonically.
	expect(await reading('todos/crlf.md')).toEqual({
		fields: { title: 'Milk', done: false, owner: 'sam' },
		body: 'One\r\nTwo\r\nThree\r\n',
	});

	click(target, 'Open in Files');
	await settle(todos);
	await eventually(() => find(CONTENTS) !== null);
	const contents = get(CONTENTS);
	const saved = (await text('todos/crlf.md'))!;
	expect(contents.value).toBe(saved.replace(/\r\n/g, '\n'));
	const typed = contents.value.replace('Three', 'Four');
	type(contents, typed);
	await settle(todos);
	expect(await text('todos/crlf.md')).toBe(typed.replace(/\n/g, '\r\n'));
});

test('while a todo is open as text its list checkbox waits; opened as a todo, completion keeps its notes and undeclared keys', async () => {
	const { todos, target, get, list, reading, text } = await setup();
	const path = 'todos/milk.md';
	const source =
		'---\ntitle: Milk\ndone: false\nowner: keep-me\n---\nCurrent notes.';
	expectOk(await todos.folder.files.create(path, source));
	await todos.queryClient.invalidateQueries({ queryKey: ['todos'] });
	todos.select(path, 'files');
	await settle(todos);
	const contents = get(CONTENTS);
	expect(contents.value).toBe(source);
	const completion = () =>
		list().querySelector<HTMLButtonElement>('[role="checkbox"]')!;

	// The text is what saves while it is open; the list's checkbox waits.
	type(contents, `${source}\nTyped in Files.`);
	expect(completion().disabled).toBe(true);
	press(completion());
	await settle(todos);
	expect(completion().getAttribute('aria-checked')).toBe('false');
	expect(await text(path)).toBe(`${source}\nTyped in Files.`);

	click(target, 'Open as todo');
	await settle(todos);
	expect(completion().disabled).toBe(false);
	press(completion());
	flushSync();
	expect(completion().getAttribute('aria-checked')).toBe('true');
	expect(get<HTMLButtonElement>(DONE).getAttribute('aria-checked')).toBe(
		'true',
	);
	await settle(todos);
	expect(await reading(path)).toEqual({
		fields: { title: 'Milk', done: true, owner: 'keep-me' },
		body: 'Current notes.\nTyped in Files.',
	});
	press(get<HTMLButtonElement>(DONE));
	await settle(todos);
	expect(completion().getAttribute('aria-checked')).toBe('false');
	expect(await reading(path)).toEqual({
		fields: { title: 'Milk', done: false, owner: 'keep-me' },
		body: 'Current notes.\nTyped in Files.',
	});
});
