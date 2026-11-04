/**
 * `<Opening>` and the folder adapted once at module scope.
 *
 * Key behaviors:
 * - `<Opening>` shows a spinner while the folder opens, Recovery with the
 *   typed error when it failed, and the pages once it is ready
 * - Recovery's Retry reopens the folder, and only the folder
 * - A page that throws shows the page error, never the folder's Recovery
 * - A folder wrapped by `fromClient` at module scope stays reactive in a
 *   component that reads it, and `edit()` still stops with its component
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import {
	type Client,
	defineContract,
	type NoteClient,
} from '@epicenter/definition/contract';
import { createFolder, OpenFolderError } from '@epicenter/folder/core';
import type { Result } from 'wellcrafted/result';

const { flushSync, mount, unmount, tick } = await import('svelte');
const { fromClient } = await import('./client.svelte.js');
const { default: OpeningHost } = await import('./fixtures/OpeningHost.svelte');
const { default: TodoCount } = await import('./fixtures/TodoCount.svelte');
const { default: TodoEditor } = await import('./fixtures/TodoEditor.svelte');
const app = await import('./fixtures/app.test-support.js');

const contract = defineContract({
	collections: { todos: { path: 'todos/{id}.md' } },
});
type Opened = Result<Client<typeof contract>, OpenFolderError>;

/** A folder whose opens the test answers, adapted as an app adapts it. */
function controlled() {
	const answers: ((opened: Opened) => void)[] = [];
	const revealed: string[] = [];
	const raw = createFolder(
		contract,
		() => new Promise<Opened>((resolve) => answers.push(resolve)),
		{
			reveal: async () => {
				revealed.push('Data');
				return { data: null, error: null };
			},
		},
	);
	return {
		folder: fromClient(raw),
		answers,
		revealed,
		/** Answer the latest open with a client whose collection is empty. */
		open() {
			const todos = {
				fieldNames: [],
				list: async () => ({ data: { items: [], invalid: [] }, error: null }),
				subscribe: () => () => {},
				replace: async () => ({ data: null, error: null }),
			} as unknown as NoteClient<(typeof contract)['collections']['todos']>;
			answers.at(-1)?.({ data: { todos }, error: null });
		},
	};
}

const settle = async () => {
	await Bun.sleep(0);
	flushSync();
};

function target() {
	const main = document.createElement('main');
	document.body.replaceChildren(main);
	return main;
}

const recovery = (main: HTMLElement) =>
	main.querySelector('[data-testid="recovery"]');

test('a spinner while opening, Recovery with the typed error, and Retry reopens until the pages show', async () => {
	const { folder, answers, open, revealed } = controlled();
	const main = target();
	const view = mount(OpeningHost, { target: main, props: { folder } });
	flushSync();
	expect(main.querySelector('[data-testid="pages"]')).toBeNull();
	expect(recovery(main)).toBeNull();
	expect(main.querySelector('[aria-live="polite"]')).not.toBeNull();

	answers.at(-1)?.(
		OpenFolderError.Disconnected({
			folder: '/Users/me/Epicenter/todos',
			target: '/Volumes/gone',
		}),
	);
	await settle();
	expect(main.textContent).toContain('Todos could not open its folder');
	expect(main.textContent).toContain('/Users/me/Epicenter/todos');

	const [retry, show] = [...main.querySelectorAll('button')];
	show?.click();
	await settle();
	expect(revealed).toEqual(['Data']);
	retry?.click();
	flushSync();
	expect(answers).toHaveLength(2);
	expect(recovery(main)).toBeNull();
	open();
	await settle();
	expect(main.querySelector('[data-testid="pages"]')?.textContent).toBe(
		'pages',
	);
	await unmount(view);
});

test('a folder with no place to show offers Retry alone', async () => {
	const raw = createFolder(contract, async () =>
		OpenFolderError.StorageUnavailable({ cause: 'no private storage' }),
	);
	const main = target();
	const view = mount(OpeningHost, {
		target: main,
		props: { folder: fromClient(raw) },
	});
	await settle();
	expect(recovery(main)).not.toBeNull();
	expect(
		[...main.querySelectorAll('button')].map((b) => b.textContent),
	).toEqual(['Retry']);
	await unmount(view);
});

test('a page that throws shows the page error, never the folder’s Recovery', async () => {
	const { folder, open } = controlled();
	open();
	const main = target();
	const view = mount(OpeningHost, {
		target: main,
		props: { folder, crash: true },
	});
	await settle();
	expect(recovery(main)).toBeNull();
	expect(
		main.querySelector('[data-testid="page-error"]')?.textContent,
	).toContain('page render bug');
	await unmount(view);
});

test('a folder wrapped once at module scope stays reactive in a component that reads it', async () => {
	const main = target();
	const view = mount(TodoCount, { target: main });
	flushSync();
	await settle();
	expect(main.textContent).toBe('0 todos');
	await app.raw.todos.create({ id: 'a', title: 'Milk', done: false });
	await settle();
	expect(main.textContent).toBe('1 todos');
	await unmount(view);
});

test('edit() on the module-scope folder stops with its component', async () => {
	type Edit = Parameters<Parameters<typeof TodoEditor>[1]['expose']>[0];
	await app.raw.todos.create({ id: 'b', title: 'Eggs', done: false });
	let editor: Edit | undefined;
	const main = target();
	const view = mount(TodoEditor, {
		target: main,
		props: { id: 'b', expose: (edit: Edit) => (editor = edit) },
	});
	await settle();
	if (editor === undefined) throw new Error('expected the editor');
	editor.fields.title = 'Brown eggs';
	expect((await editor.landed()).error).toBeNull();
	expect((await app.raw.todos.get({ id: 'b' })).data?.title).toBe('Brown eggs');

	await unmount(view);
	await tick();
	editor.fields.title = 'After it is gone';
	await settle();
	expect((await app.raw.todos.get({ id: 'b' })).data?.title).toBe('Brown eggs');
	expect(app.folder.todos.get({ id: 'b' })?.title).toBe('Brown eggs');
});
