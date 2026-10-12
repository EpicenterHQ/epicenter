/**
 * Todo Detail Mounted Tests
 *
 * Mounts the real detail pane (`Detail`, which `TodosView` renders), with
 * its real `TodoDetail`, `FileView`, `SaveBar`, `FileNameBar`, and
 * `@epicenter/ui` controls, in jsdom over the real Todos owner
 * (`createTodos`) and a real browser folder on the in-memory OPFS stand-in.
 * Each view is keyed by the open item. Typing goes through the DOM, into the
 * shared `Input` and `Textarea` and their function bindings; another writer
 * changes the file through `folder.files`.
 *
 * Key behaviors:
 * - Typing a title or notes saves at once. Each todo gets its own view: A
 *   then B then A mounts new controls, A's left-over controls admit nothing,
 *   and each input saves at its own path
 * - Another writer's change merges with the next edit; a title both changed
 *   shows in the save bar's review with no Cancel. Using "Saved elsewhere"
 *   and Apply shows their version in the same session; using "Your edit"
 *   saves the draft there and keeps their other changes
 * - A file deleted elsewhere shows in the review as a whole file: using
 *   "Your edit" creates it again from the draft, and using "Saved
 *   elsewhere" leaves it deleted, closes it, and writes nothing
 * - Returning to the window shows another writer's change when nothing is
 *   unsaved, and keeps a draft that could not save
 * - Files opens a todo's complete text and the list opens its fields. A
 *   malformed row opened as a todo opens as text and says why; repaired
 *   there, Open as todo shows its fields in a new view
 * - A draft that could not save keeps the todo open, with its input, until
 *   it saves; then Files opens its text, and the todo view's detached
 *   controls admit nothing to the released session or a new one
 * - A title the file cannot hold is not saved and says why; a valid one saves
 * - Notes and Files' text show LF and keep the file's CRLF
 * - A view hidden while its todo stays open admits nothing from its detached
 *   fields, checkbox, file name bar, or save bar buttons
 * - List completion while Files shows the same todo changes nothing there;
 *   opened as a todo, completion keeps its notes and undeclared keys
 *
 * jsdom implements no layout, focus, selection, IME, or `inert`; a field
 * that left the document receiving input shows what a delivered event does,
 * not that a person can type there. Toasts, the clipboard, and the
 * confirmation dialog are not exercised.
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
	opfsOf,
} from '../../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from '../../lib/definition.js';
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

/** The real owner over a fresh browser folder, with the host mounted over it. */
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
	const todos: Todos = createTodos(folder);
	cleanup.push(() => todos.close());
	await todos.check();
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(TodoDetailHost, { target, props: { todos } });
	flushSync();
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	async function text(path: string) {
		const { data } = await folder.files.read(path);
		return data === null ? undefined : new TextDecoder().decode(data.bytes);
	}
	return {
		todos,
		opfs: opfsOf(storage),
		target,
		/** The open todo's session. */
		selected() {
			const item = todos.opened;
			if (item?.kind !== 'todo')
				throw new Error(`Expected an open todo, got ${item?.kind}`);
			return item.session;
		},
		/** The open text file's session. */
		selectedText() {
			const item = todos.opened;
			if (item?.kind !== 'text')
				throw new Error(`Expected an open text file, got ${item?.kind}`);
			return item.session;
		},
		/** The path the detail shows. */
		shown() {
			return todos.current!.path;
		},
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
		/** Another writer deletes the file. */
		async removeElsewhere(path: string) {
			expectOk(
				await folder.files.remove(expectOk(await folder.files.read(path))),
			);
		},
	};
}

const TITLE = 'input[aria-label="Title"]';
const NOTES = 'textarea[aria-label="Notes"]';
const DONE = 'button[aria-label="Done"]';
/** Files' complete-text editor, whatever the file. */
const CONTENTS = 'textarea[aria-label^="Contents of"]';
const ALERT = '[role="alert"]';

/** Let replies and effects run, then render. */
async function settle() {
	for (let i = 0; i < 10; i++) await Bun.sleep(0);
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

/** The next write of `path` fails before it publishes: a definite failure. */
function failNextWrite(opfs: ReturnType<typeof opfsOf>, path: string) {
	opfs.faults.write = (file) => {
		if (!file.endsWith(`/${path}`)) return undefined;
		opfs.faults.write = undefined;
		return 'fail';
	};
}

/** Deliver a click to an element, attached or not. */
function press(element: Element) {
	element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** The button among `root`'s descendants whose text is `text`. */
function button(root: ParentNode, text: string) {
	const found = [...root.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (found === undefined) throw new Error(`No button reads '${text}'`);
	return found;
}

/** The labels of `root`'s buttons in the save bar. */
function saveBarButtons(root: ParentNode) {
	const bar = root.querySelector('[data-testid="save-bar"]');
	if (bar === null) throw new Error('No save bar');
	return [...bar.querySelectorAll('button')].map((b) => b.textContent?.trim());
}

/** The save bar's column label for each side of a review. */
const SIDE = { local: 'Your edit', incoming: 'Saved elsewhere' } as const;

/** Wait for the merge to show the parts both changed in the save bar. */
async function reviewShown(
	target: ParentNode,
	session: { readonly review: unknown },
) {
	await eventually(
		() =>
			session.review !== undefined &&
			target.querySelector('[data-testid="save-bar"] form') !== null,
	);
}

/**
 * Take every part of the review from `side` the way a person does, with
 * "Use all from" for several parts or that side's "Use this" for one, then
 * Apply.
 */
function useAll(target: ParentNode, side: keyof typeof SIDE) {
	const bar = target.querySelector('[data-testid="save-bar"]');
	if (bar === null) throw new Error('No save bar');
	const [part, ...more] = bar.querySelectorAll('[role="group"]');
	if (part === undefined) throw new Error('No part to review');
	if (more.length > 0) click(bar, `Use all from ${SIDE[side]}`);
	else {
		// The grid lists "Your edit" first, then "Saved elsewhere".
		const [local, incoming] = [...part.querySelectorAll('button')].filter(
			(candidate) => candidate.textContent?.trim() === 'Use this',
		);
		const use = side === 'local' ? local : incoming;
		if (use === undefined) throw new Error(`No "Use this" for ${SIDE[side]}`);
		press(use);
	}
	flushSync();
	click(bar, 'Apply');
}

test("typing saves at once, and each todo gets its own view: A then B then A mounts new controls, A's left-over controls admit nothing, and each input saves at its own path", async () => {
	const { todos, target, get, selected, shown, reading } = await setup();
	await todos.create('A');
	const pathA = shown();
	await todos.create('B');
	const pathB = shown();

	await todos.open(pathA, 'todos');
	flushSync();
	const title = get<HTMLInputElement>(TITLE);
	const notes = get(NOTES);
	const a = selected();
	expect(title.value).toBe('A');
	type(title, 'A typed');
	expect(a.draft.fields.title).toBe('A typed');
	await eventually(() => a.state.status === 'saved');
	expect(target.textContent).toContain(`Saved to ${pathA}`);

	// B's view is a new one, bound to B for its whole lifetime.
	await todos.open(pathB, 'todos');
	flushSync();
	const b = selected();
	expect(b).not.toBe(a);
	expect(get<HTMLInputElement>(TITLE)).not.toBe(title);
	expect(get(NOTES)).not.toBe(notes);
	expect(get<HTMLInputElement>(TITLE).value).toBe('B');
	// A's controls left the document; what still reaches them changes nothing.
	type(title, 'from A, detached');
	type(notes, 'from A, detached\n');
	type(get<HTMLInputElement>(TITLE), 'B typed');
	type(get(NOTES), 'B notes\n');
	expect(a.draft).toEqual({
		fields: { title: 'A typed', done: false },
		body: '',
	});
	expect(b.draft).toEqual({
		fields: { title: 'B typed', done: false },
		body: 'B notes\n',
	});
	expect((await b.settled()).status).toBe('saved');

	await todos.open(pathA, 'todos');
	flushSync();
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

test('a title both changed shows in the save bar\'s review, and using "Saved elsewhere" shows their version in the same session', async () => {
	const {
		todos,
		target,
		get,
		find,
		selected,
		shown,
		text,
		overwrite,
		reading,
	} = await setup();
	await todos.create('Milk');
	const path = shown();
	flushSync();
	const session = selected();
	const title = get<HTMLInputElement>(TITLE);

	await overwrite(path, ROW('Theirs'));
	await settle();
	expect(title.value).toBe('Milk');
	type(title, 'Mine');
	await eventually(() => session.state.status === 'error');
	await reviewShown(target, session);
	expect(find(ALERT)?.textContent).toContain('This changed elsewhere.');
	// One part, so no "Use all from"; and no Cancel.
	expect(saveBarButtons(target)).toEqual([
		'Use this',
		'Use this',
		'Leave out',
		'Apply',
	]);
	expect(title.value).toBe('Mine');
	expect(await text(path)).toBe(ROW('Theirs'));

	useAll(target, 'incoming');
	await eventually(() => session.state.status === 'saved');
	expect(selected()).toBe(session);
	expect(get<HTMLInputElement>(TITLE)).toBe(title);
	expect(title.value).toBe('Theirs');
	expect(find(ALERT)).toBeNull();
	expect(await text(path)).toBe(ROW('Theirs'));

	// The next edit writes on top of their version.
	type(title, 'After');
	expect((await session.settled()).status).toBe('saved');
	expect((await reading(path)).fields.title).toBe('After');
});

test('a title both changed shows in the save bar\'s review, and using "Your edit" saves the draft there and keeps their other changes', async () => {
	const { todos, target, get, find, selected, shown, overwrite, reading } =
		await setup();
	await todos.create('Milk');
	const path = shown();
	flushSync();
	const session = selected();
	const title = get<HTMLInputElement>(TITLE);
	type(get(NOTES), 'My notes\n');
	await session.settled();

	await overwrite(path, ROW('Theirs'));
	type(title, 'Mine');
	await reviewShown(target, session);
	expect(session.review?.conflicts.map(({ kind }) => kind)).toEqual(['field']);

	useAll(target, 'local');
	await eventually(() => session.state.status === 'saved');
	expect(selected()).toBe(session);
	expect(title.value).toBe('Mine');
	expect(find(ALERT)).toBeNull();
	// Their version cleared the notes, which this draft did not change.
	expect(await reading(path)).toEqual({
		fields: { title: 'Mine', done: false },
		body: '',
	});
});

test('a file deleted elsewhere shows in the review: using "Your edit" creates it again from the draft, and using "Saved elsewhere" closes it and writes nothing', async () => {
	const {
		todos,
		target,
		get,
		find,
		selected,
		shown,
		text,
		removeElsewhere,
		reading,
	} = await setup();
	await todos.create('Milk');
	const path = shown();
	flushSync();
	const session = selected();
	const title = get<HTMLInputElement>(TITLE);

	await removeElsewhere(path);
	type(title, 'Mine');
	await reviewShown(target, session);
	expect(find(ALERT)?.textContent).toContain('This was deleted elsewhere.');
	expect(saveBarButtons(target)).toEqual(['Use this', 'Use this', 'Apply']);
	expect(title.value).toBe('Mine');
	expect(await text(path)).toBeUndefined();

	useAll(target, 'local');
	await eventually(() => session.state.status === 'saved');
	expect(selected()).toBe(session);
	expect(find(ALERT)).toBeNull();
	expect(await reading(path)).toEqual({
		fields: { title: 'Mine', done: false },
		body: '',
	});
	// The recreated file is the session's to save over.
	type(title, 'Mine again');
	expect((await session.settled()).status).toBe('saved');
	expect((await reading(path)).fields.title).toBe('Mine again');

	// Deleted again: using their side leaves it deleted, closes the todo,
	// and writes nothing.
	await removeElsewhere(path);
	type(title, 'Lost');
	await reviewShown(target, session);
	useAll(target, 'incoming');
	await eventually(() => todos.opened === undefined);
	expect(find(TITLE)).toBeNull();
	expect(target.textContent).toContain('Select a todo');
	expect(todos.unsaved).toBe(false);
	expect(await text(path)).toBeUndefined();
});

test("returning to the window shows another writer's change when nothing is unsaved, and keeps a draft that could not save", async () => {
	const { todos, opfs, target, get, find, selected, shown, text, overwrite } =
		await setup();
	await todos.create('Milk');
	const path = shown();
	flushSync();
	const session = selected();
	const title = get<HTMLInputElement>(TITLE);

	await overwrite(path, ROW('Theirs'));
	await todos.check();
	flushSync();
	expect(selected()).toBe(session);
	expect(title.value).toBe('Theirs');
	expect(session.state.status).toBe('saved');

	// A save that failed keeps its input; the next check replaces nothing.
	failNextWrite(opfs, path);
	type(title, 'Mine');
	await eventually(() => session.state.status === 'error');
	expect(find(ALERT)?.textContent).toContain('Not saved');
	expect(saveBarButtons(target)).toEqual(['Try again']);
	await overwrite(path, ROW('Theirs again'));
	await todos.check();
	flushSync();
	expect(title.value).toBe('Mine');
	expect(await text(path)).toBe(ROW('Theirs again'));

	// Try again meets their change: the title both changed shows in the review.
	click(target, 'Try again');
	await reviewShown(target, session);
	expect(find(ALERT)?.textContent).toContain('This changed elsewhere.');
	useAll(target, 'incoming');
	await eventually(() => session.state.status === 'saved');
	expect(title.value).toBe('Theirs again');
});

test('Files opens the complete text and the list opens fields; a malformed todo opens as text that says why, and repaired there, Open as todo shows its fields', async () => {
	const { todos, target, get, find, selected, selectedText, text, reading } =
		await setup();
	expectOk(await todos.folder.files.create('todos/milk.md', ROW('Milk')));
	const broken = '---\ntitle: *missing\n---\n';
	expectOk(await todos.folder.files.create('todos/bad.md', broken));
	await todos.check();
	expect(todos.repairs.map((repair) => repair.path)).toEqual(['todos/bad.md']);

	// The same file, from each surface.
	await todos.open('todos/milk.md', 'files');
	flushSync();
	expect(get(CONTENTS).value).toBe(ROW('Milk'));
	expect(find(TITLE)).toBeNull();
	await todos.open('todos/milk.md', 'todos');
	flushSync();
	expect(get<HTMLInputElement>(TITLE).value).toBe('Milk');
	expect(find(CONTENTS)).toBeNull();

	// A malformed row opened as a todo opens as its text, and says why.
	await todos.open('todos/bad.md', 'todos');
	flushSync();
	const bad = selectedText();
	expect(todos.current).toEqual({ path: 'todos/bad.md', workspace: 'todos' });
	expect(find('[data-testid="row-issues"]')?.textContent).toContain(
		'Needs repair',
	);
	expect(find(TITLE)).toBeNull();
	expect(find(DONE)).toBeNull();
	const contents = get(CONTENTS);
	expect(contents.value).toBe(broken);
	expect(button(target, 'Open as todo').disabled).toBe(true);

	// Repaired as text, it saves as typed and offers Open as todo.
	type(contents, ROW('Fixed'));
	await eventually(
		() =>
			bad.state.status === 'saved' &&
			find('[data-testid="row-issues"]') === null,
	);
	expect(await text('todos/bad.md')).toBe(ROW('Fixed'));
	expect(button(target, 'Open as todo').disabled).toBe(false);
	await todos.check();
	flushSync();
	expect(todos.repairs).toEqual([]);
	expect(get(CONTENTS)).toBe(contents);

	// Open as todo is a new view on a new session.
	click(target, 'Open as todo');
	await eventually(() => find(TITLE) !== null);
	const fixed = selected();
	expect(get<HTMLInputElement>(TITLE).value).toBe('Fixed');
	// Files' textarea left; what still reaches it writes nothing.
	type(contents, 'junk from the departed text');
	expect(bad.draft).toBe(ROW('Fixed'));
	type(get<HTMLInputElement>(TITLE), 'Live');
	type(get(NOTES), 'live notes\n');
	press(get<HTMLButtonElement>(DONE));
	expect((await fixed.settled()).status).toBe('saved');
	expect(await reading('todos/bad.md')).toEqual({
		fields: { title: 'Live', done: true },
		body: 'live notes\n',
	});
});

test("a draft that could not save keeps the todo open with its input until it saves; then Files opens its text, and the todo view's detached controls admit nothing", async () => {
	const { todos, opfs, target, get, find, selected, shown, text } =
		await setup();
	await todos.create('Milk');
	const path = shown();
	flushSync();
	const session = selected();
	const title = get<HTMLInputElement>(TITLE);
	const done = get<HTMLButtonElement>(DONE);
	failNextWrite(opfs, path);
	type(title, 'Mine');
	await eventually(() => session.state.status === 'error');

	// Opening another item asks first; nothing opens in its place meanwhile.
	expect(await todos.open(path, 'files')).toMatchObject({ kind: 'unsaved' });
	flushSync();
	expect(selected()).toBe(session);
	expect(get<HTMLInputElement>(TITLE)).toBe(title);
	expect(title.value).toBe('Mine');
	expect(find(CONTENTS)).toBeNull();
	expect(todos.unsaved).toBe(true);

	click(target, 'Try again');
	await eventually(() => session.state.status === 'saved');
	const saved = (await text(path))!;
	expect(saved).toContain('title: Mine');
	click(target, 'Open in Files');
	await eventually(() => find(CONTENTS) !== null);
	expect(get(CONTENTS).value).toBe(saved);

	// The todo view's controls left the document; what reaches them changes nothing.
	type(title, 'from the departed title');
	press(done);
	expect(session.draft).toEqual({
		fields: { title: 'Mine', done: false },
		body: '',
	});

	// The todo opens again in a new session at the same path; the first
	// view's detached controls reach neither.
	await todos.open(path, 'todos');
	flushSync();
	const reopened = selected();
	expect(reopened).not.toBe(session);
	type(title, 'from the first view');
	press(done);
	await settle();
	expect(reopened.draft).toEqual({
		fields: { title: 'Mine', done: false },
		body: '',
	});
	expect(session.draft).toEqual({
		fields: { title: 'Mine', done: false },
		body: '',
	});
	expect(await text(path)).toBe(saved);
});

test('a title the file cannot hold is not saved and says why, and a valid title saves', async () => {
	const { todos, target, get, find, selected, shown, reading } = await setup();
	await todos.create('Milk');
	const path = shown();
	flushSync();
	const session = selected();
	const title = get<HTMLInputElement>(TITLE);

	title.value = 'Oat \uD800';
	expect(title.value.isWellFormed()).toBe(false);
	title.dispatchEvent(new window.Event('input', { bubbles: true }));
	await settle();
	expect(session.state).toMatchObject({
		status: 'error',
		error: { name: 'InvalidValues' },
	});
	expect(find(ALERT)?.textContent).toContain('Not saved');
	expect(saveBarButtons(target)).toEqual([]);
	expect(await reading(path)).toEqual({
		fields: { title: 'Milk', done: false },
		body: '',
	});

	type(title, 'Oat');
	expect((await session.settled()).status).toBe('saved');
	flushSync();
	expect(find(ALERT)).toBeNull();
	expect((await reading(path)).fields.title).toBe('Oat');
});

test("notes and Files' text show LF, and typing in them keeps the file's CRLF and undeclared keys", async () => {
	const { todos, target, get, find, selected, selectedText, text, reading } =
		await setup();
	const crlf =
		'---\r\ntitle: Milk\r\ndone: false\r\nowner: sam\r\n---\r\nOne\r\nTwo\r\n';
	expectOk(await todos.folder.files.create('todos/crlf.md', crlf));
	await todos.refresh();
	await todos.open('todos/crlf.md', 'todos');
	flushSync();
	const session = selected();
	const notes = get(NOTES);
	expect(notes.value).toBe('One\nTwo\n');

	type(notes, 'One\nTwo\nThree\n');
	expect((await session.settled()).status).toBe('saved');
	// The body keeps the file's CRLF; the frontmatter is written canonically.
	expect(await reading('todos/crlf.md')).toEqual({
		fields: { title: 'Milk', done: false, owner: 'sam' },
		body: 'One\r\nTwo\r\nThree\r\n',
	});

	click(target, 'Open in Files');
	await eventually(() => find(CONTENTS) !== null);
	const contents = get(CONTENTS);
	const saved = (await text('todos/crlf.md'))!;
	expect(contents.value).toBe(saved.replace(/\r\n/g, '\n'));
	const typed = contents.value.replace('Three', 'Four');
	type(contents, typed);
	expect((await selectedText().settled()).status).toBe('saved');
	expect(await text('todos/crlf.md')).toBe(typed.replace(/\n/g, '\r\n'));
});

test('a view hidden while its todo stays open admits nothing from its detached fields, checkbox, file name bar, or save bar buttons; shown again, the same todo takes input', async () => {
	const { todos, opfs, target, get, find, selected, shown, reading } =
		await setup();
	await todos.create('Milk');
	const path = shown();
	flushSync();
	const session = selected();
	const title = get<HTMLInputElement>(TITLE);
	const notes = get(NOTES);
	const done = get<HTMLButtonElement>(DONE);
	const form = get<HTMLFormElement>('form');
	const name = get<HTMLInputElement>('form input');
	const remove = button(form, 'Delete');
	failNextWrite(opfs, path);
	type(title, 'Mine');
	await eventually(() => session.state.status === 'error');
	const retry = button(target, 'Try again');

	click(target, 'Hide detail');
	flushSync();
	expect(find(TITLE)).toBeNull();
	expect(target.querySelector('[data-view="hidden"]')).not.toBeNull();
	expect(selected()).toBe(session);

	// Events still delivered to the view's detached nodes, one at a time.
	type(title, 'from a detached title');
	type(notes, 'from detached notes\n');
	press(done);
	expect(session.draft).toEqual({
		fields: { title: 'Mine', done: false },
		body: '',
	});
	type(name, 'renamed');
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	press(remove);
	press(retry);
	await settle();
	expect(session.state.status).toBe('error');
	expect(session.draft.fields.title).toBe('Mine');
	expect(await reading(path)).toEqual({
		fields: { title: 'Milk', done: false },
		body: '',
	});
	expect(todos.current?.path).toBe(path);

	// Negative control: shown again, the same todo takes input and Try again.
	click(target, 'Show detail');
	flushSync();
	expect(selected()).toBe(session);
	click(target, 'Try again');
	await eventually(() => session.state.status === 'saved');
	type(get<HTMLInputElement>(TITLE), 'Live');
	expect((await session.settled()).status).toBe('saved');
	expect((await reading(path)).fields.title).toBe('Live');
});

test('a save bar button left from an earlier view answers nothing for the todo open now', async () => {
	const { todos, target, get, selected, selectedText, overwrite } =
		await setup();
	const path = 'todos/milk.md';
	expectOk(await todos.folder.files.create(path, ROW('Milk')));
	await todos.refresh();
	await todos.open(path, 'files');
	flushSync();
	const file = selectedText();
	await overwrite(path, ROW('Theirs'));
	type(get(CONTENTS), ROW('Mine'));
	await reviewShown(target, file);
	const retired = button(target, 'Apply');
	useAll(target, 'local');
	await eventually(() => file.state.status === 'saved');

	await todos.open(path, 'todos');
	flushSync();
	const session = selected();
	await overwrite(path, ROW('Theirs again'));
	type(get<HTMLInputElement>(TITLE), 'Newer');
	await eventually(() => session.state.status === 'error');
	press(retired);
	await settle();
	expect(selected()).toBe(session);
	expect(session.draft.fields.title).toBe('Newer');
	expect(session.state.status).toBe('error');
	expect(session.review).toBeDefined();
});

test('list completion while Files shows the same todo changes nothing there; opened as a todo, completion and reopening keep its notes and undeclared keys', async () => {
	const { todos, target, get, selected, selectedText, reading, text } =
		await setup();
	const path = 'todos/milk.md';
	const source =
		'---\ntitle: Milk\ndone: false\nowner: keep-me\n---\nCurrent notes.';
	expectOk(await todos.folder.files.create(path, source));
	await todos.refresh();
	await todos.open(path, 'files');
	flushSync();
	const contents = get(CONTENTS);
	expect(contents.value).toBe(source);

	const { default: TodoList } = await import('./TodoList.svelte');
	const listTarget = document.createElement('div');
	document.body.append(listTarget);
	const list = mount(TodoList, { target: listTarget, props: { todos } });
	cleanup.push(async () => {
		await unmount(list);
		listTarget.remove();
	});
	flushSync();
	const completion =
		listTarget.querySelector<HTMLButtonElement>('[role="checkbox"]');
	if (completion === null) throw new Error('No list completion control');

	// The text is the open file's one editor: completion from the list is
	// refused, and the typing in Files stays as it was.
	type(contents, `${source}\nTyped in Files.`);
	const file = selectedText();
	expect(
		await todos.toggle(todos.entries.find((entry) => entry.path === path)!),
	).toContain('open as text');
	press(completion);
	await settle();
	expect(completion.getAttribute('aria-checked')).toBe('false');
	expect(get(CONTENTS)).toBe(contents);
	expect((await file.settled()).status).toBe('saved');
	expect(contents.value).toBe(`${source}\nTyped in Files.`);
	expect(await text(path)).toBe(`${source}\nTyped in Files.`);
	expect(todos.current).toEqual({ workspace: 'files', path });

	click(target, 'Open as todo');
	await eventually(() => todos.opened?.kind === 'todo');
	const session = selected();
	press(completion);
	await eventually(() => completion.getAttribute('aria-checked') === 'true');
	expect(session.draft.fields.done).toBe(true);
	expect(get<HTMLButtonElement>(DONE).getAttribute('aria-checked')).toBe(
		'true',
	);
	expect((await session.settled()).status).toBe('saved');
	expect(await reading(path)).toEqual({
		fields: { title: 'Milk', done: true, owner: 'keep-me' },
		body: 'Current notes.\nTyped in Files.',
	});
	press(completion);
	await eventually(() => completion.getAttribute('aria-checked') === 'false');
	expect((await session.settled()).status).toBe('saved');
	expect(await reading(path)).toEqual({
		fields: { title: 'Milk', done: false, owner: 'keep-me' },
		body: 'Current notes.\nTyped in Files.',
	});
});
