/**
 * `useFolder` and `useDraft` in real React 19 roots under happy-dom, over an
 * in-memory host.
 *
 * Key behaviors:
 * - A list re-renders when a row it shows lands
 * - A component that only writes never re-renders from the folder
 * - A detail view re-renders only when its own row changes
 * - A draft shows typing until its save answers, then the landed text
 */
import { afterEach, expect, test } from 'bun:test';
import type { Folder, Opened } from '@epicenter/folder/next';
import { createFolder, memoryHost } from '@epicenter/folder/next/testing';
import { Window } from 'happy-dom';
import { act, memo, type ReactNode } from 'react';
import { Type } from 'typebox';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createFolderContext, useDraft } from './folder.js';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
	window,
	document: window.document,
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	Node: window.Node,
	Event: window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');

const tables = {
	todos: Type.Object({ title: Type.String(), done: Type.Boolean() }),
};
const { OpenFolder, useFolder } = createFolderContext<typeof tables>();
const todo = (title: string, done = false) =>
	`---\ntitle: ${title}\ndone: ${done}\n---\n`;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
	const memory = memoryHost({
		'todos/milk.md': todo('Milk'),
		'todos/eggs.md': todo('Eggs'),
	});
	const folder = expectOk(
		await createFolder(memory.storage, { tables, throttleMs: 0 }),
	);
	return { folder, memory };
}

async function mount(
	folder: Folder<typeof tables>,
	children: ReactNode,
	onFailed?: (failure: import('./folder.js').SaveFailure) => void,
) {
	const host = document.createElement('div');
	document.body.append(host);
	const root = createRoot(host);
	act(() =>
		root.render(
			<OpenFolder open={() => Promise.resolve(Ok(folder))} onFailed={onFailed}>
				{children}
			</OpenFolder>,
		),
	);
	cleanup.push(() => act(() => root.unmount()));
	await settle();
	return host;
}

const settle = () =>
	act(() => new Promise((resolve) => setTimeout(resolve, 5)));

test('a list re-renders when a row lands; an item that only writes does not', async () => {
	const { folder } = await setup();
	const renders = { list: 0, items: 0 };
	const Item = memo(function Item({
		id,
		title,
	}: {
		id: string;
		title: string;
	}) {
		const writer = useFolder();
		renders.items++;
		return (
			<button
				type="button"
				onClick={() =>
					writer.tables.todos.update(id, { fields: { done: true } })
				}
			>
				{title}
			</button>
		);
	});
	function List() {
		const view = useFolder();
		renders.list++;
		const open = view.tables.todos.rows.filter(
			(row) => row.issues === null && !row.fields.done,
		);
		return (
			<ul>
				{open.map((row) =>
					row.issues === null ? (
						<Item key={row.id} id={row.id} title={row.fields.title} />
					) : null,
				)}
			</ul>
		);
	}
	const host = await mount(folder, <List />);
	expect(host.textContent).toBe('EggsMilk');
	expect(renders).toEqual({ list: 1, items: 2 });

	await act(() =>
		folder.tables.todos.update('milk', { fields: { done: true } }),
	);
	await settle();
	expect(host.textContent).toBe('Eggs');
	expect(renders.list).toBe(2);
	// Eggs kept its props, and reads nothing from the folder.
	expect(renders.items).toBe(2);
});

test('a detail view re-renders only when its own row changes', async () => {
	const { folder } = await setup();
	let renders = 0;
	function Detail({ id }: { id: string }) {
		const view = useFolder();
		const row = view.tables.todos.row(id);
		renders++;
		return <p>{row?.issues === null ? row.fields.title : 'gone'}</p>;
	}
	const host = await mount(folder, <Detail id="eggs" />);
	expect(host.textContent).toBe('Eggs');
	expect(renders).toBe(1);
	await act(() =>
		folder.tables.todos.update('milk', { fields: { title: 'Oat' } }),
	);
	await settle();
	expect(renders).toBe(1);
	await act(() =>
		folder.tables.todos.update('eggs', { fields: { title: 'Duck eggs' } }),
	);
	await settle();
	expect(host.textContent).toBe('Duck eggs');
	expect(renders).toBe(2);
});

test('a draft shows typing until its save answers, then the landed text', async () => {
	const { folder } = await setup();
	let setTitle: (text: string) => void = () => {};
	function Editor() {
		const view = useFolder();
		const row = view.tables.todos.row('milk');
		const title = useDraft(
			row?.issues === null ? row.fields.title : '',
			(text) => view.tables.todos.update('milk', { fields: { title: text } }),
		);
		setTitle = title.set;
		return (
			<input
				value={title.text}
				onChange={(event) => title.set(event.target.value)}
			/>
		);
	}
	const host = await mount(folder, <Editor />);
	const input = () => host.querySelector('input');
	expect(input()?.value).toBe('Milk');
	act(() => setTitle('Oat'));
	expect(input()?.value).toBe('Oat');
	await settle();
	expect(folder.tables.todos.row('milk')?.fields?.title).toBe('Oat');
	expect(input()?.value).toBe('Oat');
});

test('onFailed receives the body of a failed update', async () => {
	const { folder, memory } = await setup();
	const failures: import('./folder.js').SaveFailure[] = [];
	let update: () => void = () => {};
	function Writer() {
		const view = useFolder();
		update = () => {
			void view.tables.todos.update('milk', { body: 'Typed body' });
		};
		return null;
	}
	await mount(folder, <Writer />, (failure) => failures.push(failure));
	memory.control.failPut.set('todos/milk.md', {
		name: 'StorageFailed',
		message: 'disk full',
		cause: null,
	});
	await act(async () => {
		update();
		await settle();
	});
	expect(failures).toMatchObject([
		{ path: 'todos/milk.md', text: 'Typed body' },
	]);
});

test('OpenFolder shows loading, then children, and closes on unmount', async () => {
	const { folder, memory } = await setup();
	const host = document.createElement('div');
	document.body.append(host);
	const root = createRoot(host);
	let release: (result: Awaited<Opened<typeof tables>>) => void = () => {};
	const opening = new Promise<Awaited<Opened<typeof tables>>>((resolve) => {
		release = resolve;
	});
	act(() =>
		root.render(
			<OpenFolder open={() => opening} loading={<p>Opening</p>}>
				<p>Ready</p>
			</OpenFolder>,
		),
	);
	expect(host.textContent).toBe('Opening');
	await act(async () => {
		release(Ok(folder));
		await opening;
	});
	expect(host.textContent).toBe('Ready');
	await act(() => root.unmount());
	expect(memory.control.closed).toBe(true);
});

test('OpenFolder renders a refusal when opening rejects', async () => {
	const host = document.createElement('div');
	const root = createRoot(host);
	act(() =>
		root.render(
			<OpenFolder
				open={() => Promise.reject(new Error('offline'))}
				refused={(error) => (
					<p>
						{error.name}: {error.message}
					</p>
				)}
			>
				<p>Ready</p>
			</OpenFolder>,
		),
	);
	await settle();
	expect(host.textContent).toContain('Unavailable');
	expect(host.textContent).toContain('offline');
	await act(() => root.unmount());
});

test('folder update reports typed text on failure', async () => {
	const { folder, memory } = await setup();
	const failures: import('./folder.js').SaveFailure[] = [];
	let update: () => void = () => {};
	function Writer() {
		const view = useFolder();
		update = () => {
			void view.update('todos/milk.md', { body: 'Folder body' });
		};
		return null;
	}
	await mount(folder, <Writer />, (failure) => failures.push(failure));
	memory.control.failPut.set('todos/milk.md', {
		name: 'StorageFailed',
		message: 'disk full',
		cause: null,
	});
	await act(async () => {
		update();
		await settle();
	});
	expect(failures).toMatchObject([
		{ path: 'todos/milk.md', text: 'Folder body' },
	]);
});
