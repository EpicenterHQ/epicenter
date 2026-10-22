/**
 * React Editor Binding Tests
 *
 * Mounts real React 19 roots in happy-dom over a real browser folder on an
 * in-memory IndexedDB, and types through the DOM handlers React committed.
 *
 * Key behaviors:
 * - A view's subscription starts the editor's first read; it tells awaiting
 *   text, a missing row, and editable content apart
 * - Typing shows at once; another handle's publication shows
 *   in a clean view, and never replaces held input
 * - The last body replacement in one event determines the input
 * - A reused view follows its path, and the row it left keeps its input
 * - Unmounting lets go of the subscription while input stays with the folder
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import type { FolderTable } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import type { FileDocument } from '@epicenter/folder/document';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { useDocument } from './document.js';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
	window,
	document: window.document,
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	HTMLTextAreaElement: window.HTMLTextAreaElement,
	Node: window.Node,
	Event: window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
type Notes = FolderTable<typeof notes>;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** A fresh profile holding `milk` and `bread`, and another writer. */
async function setup() {
	globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
	const folder = expectOk(
		await openFolder({ tables: { notes }, saveAfterMs: 60_000 }),
	);
	cleanup.push(() => folder.close());
	for (const [id, title] of [
		['milk', 'Milk'],
		['bread', 'Bread'],
	] as const)
		expectOk(
			await folder.tables.notes.write(id, {
				fields: { title, done: false },
				body: 'one\ntwo\n',
			}),
		);
	const other = expectOk(await openFolder({ tables: { notes } }));
	cleanup.push(() => other.close());
	return { folder, other };
}

/** A React root in the page, unmounted after the test. */
async function mount(element: ReactNode) {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container as unknown as Element);
	await act(async () => root.render(element));
	let mounted = true;
	const unmount = async () => {
		if (!mounted) return;
		mounted = false;
		await act(async () => root.unmount());
	};
	cleanup.push(unmount);
	return {
		root,
		container,
		unmount,
		input: () => {
			const input = container.querySelector<HTMLInputElement>('input');
			if (input === null) throw new Error('No input is shown');
			return input;
		},
		text: () => container.textContent,
	};
}

/** A keystroke through the field's committed React handler. */
function type(input: HTMLInputElement, text: string) {
	Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(input),
		'value',
	)?.set?.call(input, text);
	input.dispatchEvent(new window.Event('input', { bubbles: true }) as never);
}

/** Wait until `done`, letting React and the folder run between checks. */
async function until(done: () => boolean) {
	for (let turn = 0; turn < 200; turn++) {
		if (done()) return;
		await act(async () => Bun.sleep(5));
	}
	throw new Error('Never happened');
}

/** `table`, counting each editor's live subscriptions. */
function counted(table: Notes) {
	const live: Record<string, number> = {};
	const edits = new Map<string, FileDocument<typeof notes>>();
	const wrapped: Notes = {
		...table,
		document(id) {
			let wrappedEdit = edits.get(id);
			if (wrappedEdit !== undefined) return wrappedEdit;
			const edit = table.document(id);
			wrappedEdit = {
				...edit,
				subscribe(listener) {
					live[id] = (live[id] ?? 0) + 1;
					const stop = edit.subscribe(listener);
					return () => {
						live[id] = (live[id] ?? 0) - 1;
						stop();
					};
				},
			};
			edits.set(id, wrappedEdit);
			return wrappedEdit;
		},
	};
	return { table: wrapped, live };
}

/** A title input over one row, as an app's detail view types it. */
function Title({ table, id }: { table: Notes; id: string }) {
	const edit = table.document(id);
	const { content, loadError, isDirty } = useDocument(edit);
	if (content === undefined)
		return <p>{loadError === undefined ? 'Loading' : loadError.name}</p>;
	return (
		<label>
			<input
				value={content.issues === null ? content.fields.title : ''}
				onChange={(event) =>
					edit.patch({ fields: { title: event.currentTarget.value } })
				}
			/>
			<span>{isDirty ? 'Unsaved' : 'Saved'}</span>
		</label>
	);
}

test('a view starts the first read, and tells awaiting text, a missing row and content apart', async () => {
	const { folder } = await setup();
	const view = await mount(<Title table={folder.tables.notes} id="milk" />);
	await until(() => view.container.querySelector('input') !== null);
	expect(view.input().value).toBe('Milk');
	const missing = await mount(<Title table={folder.tables.notes} id="gone" />);
	await until(() => missing.text() === 'Missing');
});

test('typing shows at once; another handle updates a clean view and never replaces input', async () => {
	const { folder, other } = await setup();
	const view = await mount(<Title table={folder.tables.notes} id="milk" />);
	await until(() => view.container.querySelector('input') !== null);
	await act(async () => type(view.input(), 'Oat milk'));
	expect(view.input().value).toBe('Oat milk');
	expect(view.text()).toContain('Unsaved');
	expectOk(await act(() => folder.tables.notes.document('milk').save()));
	expect(view.text()).toContain('Saved');
	expectOk(
		await other.tables.notes.write('milk', {
			fields: { title: 'Theirs', done: false },
			body: 'one\ntwo\n',
		}),
	);
	await act(async () => {
		expectOk(await folder.tables.notes.list());
	});
	await until(() => view.input().value === 'Theirs');
	await act(async () => type(view.input(), 'Mine again'));
	expectOk(
		await other.tables.notes.write('milk', {
			fields: { title: 'Later', done: false },
			body: 'one\ntwo\n',
		}),
	);
	await act(async () => {
		expectOk(await folder.tables.notes.list());
		await Bun.sleep(20);
	});
	expect(view.input().value).toBe('Mine again');
	expect(view.text()).toContain('Unsaved');
});

test('the last body replacement in one event determines the input', async () => {
	const { folder } = await setup();
	const edit = folder.tables.notes.document('milk');
	function Body() {
		const { content } = useDocument(edit);
		if (content === undefined) return <p>Loading</p>;
		return (
			<input
				value={content.body ?? ''}
				onChange={(event) => {
					edit.patch({ body: event.currentTarget.value });
					edit.patch({ body: `${event.currentTarget.value}!` });
				}}
			/>
		);
	}
	const view = await mount(<Body />);
	await until(() => view.container.querySelector('input') !== null);
	await act(async () => type(view.input(), 'typed'));
	expect(view.input().value).toBe('typed!');
	expect(edit.getSnapshot().content?.body).toBe('typed!');
});

test('a reused view follows its path, and the row it left keeps its input', async () => {
	const { folder } = await setup();
	const view = await mount(<Title table={folder.tables.notes} id="milk" />);
	await until(() => view.container.querySelector('input') !== null);
	await act(async () => type(view.input(), 'Oat milk'));
	await act(async () =>
		view.root.render(<Title table={folder.tables.notes} id="bread" />),
	);
	await until(() => view.container.querySelector('input')?.value === 'Bread');
	expect(folder.tables.notes.document('milk').getSnapshot()).toMatchObject({
		isDirty: true,
		content: { fields: { title: 'Oat milk' } },
	});
	await act(async () =>
		view.root.render(<Title table={folder.tables.notes} id="milk" />),
	);
	expect(view.input().value).toBe('Oat milk');
});

test('unmounting lets go of the subscription while input stays with the folder', async () => {
	const { folder } = await setup();
	const { table, live } = counted(folder.tables.notes);
	const view = await mount(<Title table={table} id="milk" />);
	await until(() => view.container.querySelector('input') !== null);
	expect(live.milk).toBe(1);
	await act(async () => type(view.input(), 'Oat milk'));
	await view.unmount();
	expect(live.milk).toBe(0);
	expect(folder.getStatus().unsaved).toEqual(['notes/milk.md']);
	expect(
		folder.tables.notes.document('milk').getSnapshot().content?.fields,
	).toEqual({ title: 'Oat milk', done: false });
});
