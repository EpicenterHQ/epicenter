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
 * - A typed title or notes is held by the view and saved a second after the
 *   last keystroke, or at once when the person leaves the field or the view
 *   goes away; the list shows what the save wrote. Each todo gets its own
 *   view, and each input saves at its own path
 * - Typed text survives the cache being read again before it is sent
 * - Opening another todo while a save is pending writes the pending text to
 *   the todo it was typed into, and to no other
 * - A failed save keeps the typed text, and Try again sends it
 * - Notes typed into a todo deleted elsewhere are not written; they are
 *   offered as text
 * - The checkbox sends at once and never undoes a title typed meanwhile
 * - A title saved over a change made elsewhere keeps the other fields; the
 *   typed title wins where both changed
 * - Another page's change shows without the person returning to the window
 * - A malformed todo shows under "Needs repair"; shown, its issues and text
 *   are read-only, and it reads as a todo once another editor fixes it
 * - A file that cannot be read as text is labelled "Could not read", not
 *   offered for repair
 * - The open todo follows the URL, and opening one from the list sets it
 * - A title input keeps its value well formed, so what is written is what
 *   is shown
 * - Notes show LF, and a body write writes the file in the standard form
 * - Completion from the list and the detail keep notes and undeclared keys
 *
 * jsdom implements no layout, focus, selection, IME, or `inert`. Toasts,
 * the clipboard, and the confirmation dialog are not exercised.
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { type Folder, parseRow } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import type { WriteFailure } from '@epicenter/svelte/write-failure';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
} from '../../../../../packages/folder/src/browser-storage.test-support.js';
import {
	blur,
	click,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { todosDefinition } from '../../lib/definition.js';
import { quiet } from '../../lib/query.test-support.js';
import type { Todos } from '../../lib/todos.svelte.js';

const { createFolderContext } = await import('@epicenter/svelte/folder');

const { flushSync, mount, unmount } = await import('svelte');
const { createTodos } = await import('../../lib/todos.svelte.ts');
const state = await import('../../lib/app-state.test-support.svelte.ts');
const navigation = await import('../../lib/app-navigation.test-support.ts');
mock.module('$app/state', () => state);
mock.module('$app/navigation', () => navigation);
const { page } = state;
const { goto, leave, resetUrl } = navigation;
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
			app: id,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				...browserStorage(storage),
			},
		}),
	);
	const failures: WriteFailure[] = [];
	const opened = createFolderContext(folder, {
		writeFailed: (failure) => failures.push(failure),
	});
	const todos: Todos = createTodos(opened);
	cleanup.push(() => opened.close());
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(TodosViewHost, { target, props: { opened } });
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
	const faults = opfsOf(storage).faults;
	return {
		todos,
		failures,
		/** The next write of `path` fails before it publishes. */
		failNextWrite(path: string) {
			faults.write = (file) => {
				if (!file.endsWith(`/${path}`)) return undefined;
				faults.write = undefined;
				return 'fail';
			};
		},
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
			await put(folder, path, content);
		},
		/** Another page of this origin replaces the file; the folder reports it. */
		async overwriteElsewhere(path: string, content: string) {
			const other = expectOk(
				await openFolder({
					app: id,
					definition: todosDefinition,
					browser: {
						author: { name: 'Other', email: 'other@example.test' },
						...browserStorage(storage),
					},
				}),
			);
			await put(other, path, content);
			await other.close();
		},
	};
}

/** Make `path` hold `content`, whatever is there. */
async function put(
	folder: Pick<Folder<typeof todosDefinition>, 'files' | 'write'>,
	path: string,
	content: string,
) {
	const current = await folder.files.read(path);
	expectOk(
		await folder.write(
			path,
			current.error === null ? current.data.bytes : null,
			content,
		),
	);
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
	// Nothing is sent while the person may still be typing.
	await settle(todos);
	expect(listed(list())).not.toContain('A typed');
	// A second after the last keystroke, it is.
	await Bun.sleep(1100);
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
	blur(get(TITLE));
	type(get(NOTES), 'B notes\n');
	blur(get(NOTES));
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

test('a title saved over a change made elsewhere keeps the other fields, and wins where both changed', async () => {
	const { todos, target, get, list, failures, overwrite, text } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	await overwrite(path, '---\ntitle: Milk from the shop\ndone: true\n---\n');

	type(get<HTMLInputElement>(TITLE), 'Oat milk');
	blur(get(TITLE));
	await settle(todos);
	expect(failures).toEqual([]);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Oat milk');
	expect(listed(list())).toEqual(['Oat milk']);
	expect(await text(path)).toBe('---\ntitle: Oat milk\ndone: true\n---\n');
});

test('typed text survives the cache being read again before it is sent', async () => {
	const { todos, target, get, overwriteElsewhere, reading } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	type(get<HTMLInputElement>(TITLE), 'Oat milk');
	type(get(NOTES), 'Two cartons.\n');
	// Another page changes the file; the folder reports it and the cache
	// reads it again while the typing is still held here.
	await overwriteElsewhere(
		path,
		'---\ntitle: Milk\ndone: true\n---\nFrom the shop.\n',
	);
	await eventually(
		() => get<HTMLButtonElement>(DONE).getAttribute('aria-checked') === 'true',
	);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Oat milk');
	expect(get(NOTES).value).toBe('Two cartons.\n');

	blur(get(TITLE));
	blur(get(NOTES));
	await settle(todos);
	// The title wins its field; the notes merged by line with theirs.
	expect(await reading(path)).toEqual({
		fields: { title: 'Oat milk', done: true },
		body: expect.stringContaining('Two cartons.\n'),
	});
});

test('opening another todo while a save is pending writes it to the todo it was typed into, and to no other', async () => {
	const { todos, target, get, reading } = await setup();
	const pathA = await addTodo(todos, target, 'A');
	const pathB = await addTodo(todos, target, 'B');
	await openTodo(todos, target, pathA);
	type(get<HTMLInputElement>(TITLE), 'A typed');
	type(get(NOTES), 'A notes\n');

	// No blur: the view goes away with the save still waiting for its pause.
	await openTodo(todos, target, pathB);
	await settle(todos);
	expect(get<HTMLInputElement>(TITLE).value).toBe('B');
	expect(await reading(pathA)).toEqual({
		fields: { title: 'A typed', done: false },
		body: 'A notes\n',
	});
	expect(await reading(pathB)).toEqual({
		fields: { title: 'B', done: false },
		body: '',
	});
});

test('a failed save keeps the typed text, and Try again sends it', async () => {
	const { todos, target, get, failNextWrite, reading, failures } =
		await setup();
	const path = await addTodo(todos, target, 'Milk');
	failNextWrite(path);
	type(get<HTMLInputElement>(TITLE), 'Oat milk');
	blur(get(TITLE));
	await settle(todos);
	expect(failures).toHaveLength(1);
	expect(get<HTMLInputElement>(TITLE).value).toBe('Oat milk');
	expect((await reading(path)).fields.title).toBe('Milk');
	const status = get('[data-testid="write-status"]');
	expect(status.textContent).toContain('Not saved');

	click(status, 'Try again');
	await settle(todos);
	expect((await reading(path)).fields.title).toBe('Oat milk');
	expect(get<HTMLInputElement>(TITLE).value).toBe('Oat milk');
	expect(get('[data-testid="write-status"]').textContent).toContain('Saved to');
});

test('notes typed into a todo deleted elsewhere are not written and are offered as text', async () => {
	const { todos, target, get, failures, text } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	type(get(NOTES), 'From the shop.\n');
	// Another writer deletes the file before the notes are sent; the cache
	// still holds the row.
	expectOk(await todos.folder.write(path, null, null));
	blur(get(NOTES));
	await settle(todos);
	expect(await text(path)).toBeUndefined();
	expect(failures).toMatchObject([
		{ path, unsaved: 'From the shop.\n', error: { name: 'NotFound' } },
	]);
});

test('the checkbox sends at once and does not undo a title typed meanwhile', async () => {
	const { todos, target, get, reading } = await setup();
	const path = await addTodo(todos, target, 'Milk');
	type(get<HTMLInputElement>(TITLE), 'Oat milk');
	press(get<HTMLButtonElement>(DONE));
	await settle(todos);
	expect(await reading(path)).toEqual({
		fields: { title: 'Milk', done: true },
		body: '',
	});
	// The title is still typed here, and its save keeps the checkbox's.
	expect(get<HTMLInputElement>(TITLE).value).toBe('Oat milk');
	blur(get(TITLE));
	await settle(todos);
	expect(await reading(path)).toEqual({
		fields: { title: 'Oat milk', done: true },
		body: '',
	});
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
	expectOk(await todos.folder.write('todos/bad.md', null, broken));
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
	// The repair view shows the file's exact text.
	expect(get(BROKEN).textContent).toBe(broken);
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
	blur(title);
	await settle(todos);
	expect(failures).toEqual([]);
	expect(title.value).toBe('Oat �');
	expect((await reading(path)).fields.title).toBe('Oat �');
});

test('notes from a CRLF file show LF; typing in them writes the file in the standard form with LF', async () => {
	const { todos, target, get, reading } = await setup();
	const crlf =
		'---\r\ntitle: Milk\r\ndone: false\r\nowner: sam\r\n---\r\nOne\r\nTwo\r\n';
	expectOk(await todos.folder.write('todos/crlf.md', null, crlf));
	await reread(todos);
	await openTodo(todos, target, 'todos/crlf.md');
	const notes = get(NOTES);
	expect(notes.value).toBe('One\nTwo\n');

	type(notes, 'One\nTwo\nThree\n');
	blur(notes);
	await settle(todos);
	// A body write writes the frontmatter in the standard form (ADR-0576)
	// and the body with LF (ADR-0572).
	expect(await reading('todos/crlf.md')).toEqual({
		fields: { title: 'Milk', done: false, owner: 'sam' },
		body: 'One\nTwo\nThree\n',
	});
	expect(
		new TextDecoder().decode(
			expectOk(await todos.folder.files.read('todos/crlf.md')).bytes,
		),
	).toBe('---\ntitle: Milk\ndone: false\nowner: sam\n---\nOne\nTwo\nThree\n');
});

test('completion from the list and from the detail keeps notes and undeclared keys', async () => {
	const { todos, target, get, list, reading } = await setup();
	const path = 'todos/milk.md';
	expectOk(
		await todos.folder.write(
			path,
			null,
			'---\ntitle: Milk\ndone: false\nowner: keep-me\n---\nCurrent notes.',
		),
	);
	await reread(todos);
	await openTodo(todos, target, path);
	const completion = () =>
		list().querySelector<HTMLButtonElement>('[role="checkbox"]')!;

	press(completion());
	await settle(todos);
	// Both show the file once the set lands.
	expect(completion().getAttribute('aria-checked')).toBe('true');
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
		await todos.folder.write(
			'todos/binary.md',
			null,
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
