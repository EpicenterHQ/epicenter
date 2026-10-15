/**
 * Todo Detail Mounted Tests
 *
 * Mounts the whole `TodosView` as the page does, with the real list, the real
 * `TodoDetail` and its file name bar, and the real `@epicenter/ui` controls,
 * in jsdom inside the query client the folder's scope provides, over the real
 * Todos store (`createTodos`) and a real browser folder on the in-memory OPFS
 * stand-in. The open todo is the page URL's `?todo=`, driven through the
 * `$app/state` and `$app/navigation` stand-ins. jsdom matches no media query
 * until a test crosses the breakpoint, so the view lays out as on a narrow
 * screen: the list stays mounted, hidden, behind the open todo. Typing goes
 * through the DOM, into the shared `Input` and `Textarea` and their function
 * bindings; another writer changes the file through `folder.files`, or
 * through a second page of the same origin, whose change the folder reports.
 *
 * Key behaviors:
 * - Typing a title or notes goes into the view's draft and is saved; the
 *   list shows what the save wrote. Each todo gets its own view, and each
 *   input saves at its own path
 * - A save that meets a change made elsewhere merges with it; the edit
 *   wins where both changed
 * - Another page's change shows without the person returning to the window
 * - A malformed todo shows under "Needs repair"; shown, its issues and text
 *   are read-only, and it reads as a todo once another editor fixes it
 * - A file that cannot be read as text is labelled "Could not read", not
 *   offered for repair
 * - The open todo follows the URL, and opening one from the list sets it
 * - A title input keeps its value well formed, so what is written is what
 *   is shown
 * - Notes show LF and keep the file's CRLF
 * - Completion from the list and the detail keep notes and undeclared keys
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
import { click, setWide, type } from '../../lib/svelte-dom.test-support.js';
import type { Todos } from '../../lib/todos.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createTodos } = await import('../../lib/todos.svelte.ts');
const { page } = await import('../../lib/app-state.test-support.svelte.ts');
const { goto, leave, resetUrl } = await import(
	'../../lib/app-navigation.test-support.ts'
);
const { default: TodosViewHost } = await import(
	'./fixtures/TodosViewHost.svelte'
);

const ROW = (title: string) => `---\ntitle: ${title}\ndone: false\n---\n`;
let count = 0;
const cleanup: (() => Promise<unknown> | void)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	setWide(false);
	resetUrl();
});

/** The todo the URL opens. */
const opened = () => page.url.searchParams.get('todo') ?? undefined;
const DETAIL = 'section[aria-label="Todo"]';
const LIST = '[aria-label="Todo list"]';

/** The real store over a fresh browser folder, with the whole view mounted over it. */
async function setup() {
	const storage = createTestStorage({ BroadcastChannel });
	const id = `todo-detail-mounted-${count++}`;
	const folder = expectOk(
		await openFolder({
			id,
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
	const view = mount(TodosViewHost, { target, props: { todos } });
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
		detail: () => target.querySelector(DETAIL)!,
		list: () => target.querySelector(LIST)!,
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
		/** Another page of this origin replaces the file; the folder reports it. */
		async overwriteElsewhere(path: string, content: string) {
			const other = expectOk(
				await openFolder({
					id,
					definition: todosDefinition,
					browser: {
						author: { name: 'Other', email: 'other@example.test' },
						...browserStorage(storage),
					},
				}),
			);
			expectOk(await other.files.overwrite(path, content));
			await other.close();
		},
	};
}

const TITLE = `${DETAIL} input[aria-label="Title"]`;
const NOTES = `${DETAIL} textarea[aria-label="Notes"]`;
const DONE = `${DETAIL} button[aria-label="Done"]`;
/** A malformed todo's text, shown read-only. */
const BROKEN = `${DETAIL} pre[aria-label^="Text of"]`;

/**
 * Let writes, reads, and effects run, then render. TanStack hands observers
 * their results on a timer, so a few turns pass before the last render.
 */
async function settle(todos: Todos) {
	await quiet(todos);
	for (let turn = 0; turn < 3; turn++) {
		flushSync();
		await Bun.sleep(1);
	}
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
	const row = [...target.querySelectorAll(`${LIST} [data-todo]`)].find(
		(candidate) => candidate.getAttribute('data-todo') === path,
	);
	if (row === undefined) throw new Error(`The list does not show ${path}`);
	press(row);
	await settle(todos);
}

/** Add a todo through the list and show it, as the list does; answers its path. */
async function addTodo(todos: Todos, target: Element, title: string) {
	const before = opened();
	type(target.querySelector('[aria-label="New todo title"]'), title);
	flushSync();
	click(target.querySelector(LIST)!, 'Add');
	await settle(todos);
	await eventually(() => opened() !== undefined && opened() !== before);
	return `todos/${opened()}.md`;
}

/** Read every listing again, as Check again does. */
async function reread(todos: Todos) {
	await todos.refresh();
	await settle(todos);
}

test('typing is saved, the list shows what was saved, and each todo saves at its own path', async () => {
	const { todos, target, get, list, reading } = await setup();
	const pathA = await addTodo(todos, target, 'A');
	const pathB = await addTodo(todos, target, 'B');

	await openTodo(todos, target, pathA);
	const title = get<HTMLInputElement>(TITLE);
	expect(title.value).toBe('A');
	type(title, 'A typed');
	await settle(todos);
	// The save put the row it wrote in the cache the list reads.
	expect(listed(list())).toContain('A typed');
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

test('a save that meets a change made elsewhere merges with it, and the edit wins where both changed', async () => {
	const { todos, target, get, list, failures, overwrite, text } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	await overwrite(path, ROW('Milk from the shop'));

	type(get<HTMLInputElement>(TITLE), 'Oat milk');
	await settle(todos);
	expect(failures).toEqual([]);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Oat milk');
	expect(listed(list())).toEqual(['Oat milk']);
	expect(await text(path)).toBe(ROW('Oat milk'));
});

test("another page's change shows without returning to the window", async () => {
	const { todos, target, get, list, overwriteElsewhere } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	await overwriteElsewhere(path, ROW('Milk, edited elsewhere'));
	await eventually(
		() => get<HTMLInputElement>(TITLE).value === 'Milk, edited elsewhere',
	);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Milk, edited elsewhere');
	expect(listed(list())).toEqual(['Milk, edited elsewhere']);
});

test('a malformed todo shows under "Needs repair"; shown, its issues and text are read-only, and it reads as a todo once another editor fixes it', async () => {
	const { todos, get, find, list, overwrite } = await setup();
	const broken = '---\r\ntitle: *missing\r\n---\r\n';
	expectOk(await todos.folder.files.create('todos/bad.md', broken));
	await reread(todos);
	const repairs = () => list().querySelector('[aria-label="Needs repair"]');
	expect(repairs()?.textContent).toContain('todos/bad.md');

	click(repairs()!, 'Show');
	await settle(todos);
	expect(find('[data-testid="needs-repair"]')?.textContent).toContain(
		'Needs repair',
	);
	expect(find(TITLE)).toBeNull();
	expect(find(`${DETAIL} textarea`)).toBeNull();
	expect(get(BROKEN).textContent).toBe(broken.replace(/\r\n/g, '\n'));
	expect(leave()).toBe(false);

	// Another editor fixes it; reading again shows it.
	await overwrite('todos/bad.md', ROW('Fixed'));
	await reread(todos);
	expect(repairs()).toBeNull();
	expect(find(BROKEN)).toBeNull();
	expect(get<HTMLInputElement>(TITLE).value).toBe('Fixed');
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
	// The list's own draft shows it at once; the detail, once it is saved.
	expect(completion().getAttribute('aria-checked')).toBe('true');
	await settle(todos);
	expect(get<HTMLButtonElement>(DONE).getAttribute('aria-checked')).toBe(
		'true',
	);
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

test('a file that cannot be read as text is labelled "Could not read", with no repair', async () => {
	const { todos, list } = await setup();
	expectOk(
		await todos.folder.files.create(
			'todos/binary.md',
			new Uint8Array([0xff, 0xfe, 0x00]),
		),
	);
	await reread(todos);
	const unreadable = list().querySelector('[aria-label="Could not read"]');
	expect(unreadable?.textContent).toContain('todos/binary.md');
	expect(
		[...(unreadable?.querySelectorAll('button') ?? [])].map((button) =>
			button.textContent?.trim(),
		),
	).toEqual(['Try again']);
	expect(list().querySelector('[aria-label="Needs repair"]')).toBeNull();
});

test('the open todo follows the URL, and opening one from the list sets it', async () => {
	const { todos, target, get, detail } = await setup();
	const milk = await addTodo(todos, target, 'Milk');
	const bread = await addTodo(todos, target, 'Bread');
	const stemOf = (path: string) => path.slice('todos/'.length, -'.md'.length);
	expect(opened()).toBe(stemOf(bread));

	await goto(`?todo=${encodeURIComponent(stemOf(milk))}`);
	await settle(todos);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Milk');

	await openTodo(todos, target, bread);
	expect(opened()).toBe(stemOf(bread));
	expect(get<HTMLInputElement>(TITLE).value).toBe('Bread');

	// A todo the folder does not hold says so.
	await goto('?todo=missing');
	await settle(todos);
	expect(detail().textContent).toContain(
		'This todo is no longer in the folder',
	);
});
