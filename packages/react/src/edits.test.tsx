/**
 * React Edit Binding Tests
 *
 * Mounts real React 19 roots in happy-dom over a real browser folder on an
 * in-memory IndexedDB, and types through the DOM handlers React committed.
 *
 * Key behaviors:
 * - Typing names what the committed render showed, the folder's own save
 *   included, never what a suspended transition rendered but did not commit
 * - Closing the folder re-renders a view whose held input keeps the same
 *   pending value, because the input fence is its own snapshot
 * - A reused view follows its path, and the row it left keeps its input
 * - Unmounting every view lets go of its subscriptions while the input and
 *   its timer stay with the folder
 * - The text binding shows held text over this render's bytes, BOM kept
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { fileBytes, type Row } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import type { RowEdit, RowPending } from '@epicenter/folder/edits';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { Window } from 'happy-dom';
import {
	act,
	type ReactNode,
	Suspense,
	startTransition,
	use,
	useState,
} from 'react';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { useRowEdit, useTextEdit } from './edits.js';

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
type Note = Row<typeof notes>;
type Folder = Awaited<ReturnType<typeof setup>>['folder'];

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** A fresh profile holding `milk` and `bread`, opened with `saveAfterMs`, and another writer. */
async function setup({ saveAfterMs = 60_000 } = {}) {
	globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
	const folder = expectOk(await openFolder({ tables: { notes }, saveAfterMs }));
	cleanup.push(() => folder.close());
	for (const [id, title] of [
		['milk', 'Milk'],
		['bread', 'Bread'],
	] as const)
		expectOk(
			await folder.tables.notes.set(id, null, {
				fields: { title, done: false },
				body: '',
			}),
		);
	const other = expectOk(await openFolder({ tables: { notes } }));
	cleanup.push(() => other.close());
	const read = async (id: string) => {
		const row = expectOk(await other.tables.notes.get(id));
		if (row === undefined) throw new Error(`${id} is not stored`);
		return row;
	};
	/** The row as this folder's view reads it. */
	const observe = async (id: string) => {
		const row = expectOk(await folder.tables.notes.get(id));
		if (row === undefined) throw new Error(`${id} is not stored`);
		return row;
	};
	return { folder, other, read, observe };
}

/** A React root in the page, unmounted after the test. */
async function mount(element: ReactNode) {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container as unknown as Element);
	await act(async () => root.render(element));
	cleanup.push(() => act(async () => root.unmount()));
	return {
		root,
		input: () => {
			const input = container.querySelector<
				HTMLInputElement | HTMLTextAreaElement
			>('input, textarea');
			if (input === null) throw new Error('No input is shown');
			return input;
		},
	};
}

/** A keystroke through the field's committed React handler. */
function type(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
	Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(input),
		'value',
	)?.set?.call(input, text);
	input.dispatchEvent(new window.Event('input', { bubbles: true }) as never);
}

/** `edit`, recording each source it was changed over and counting live subscriptions. */
function recorded(edit: RowEdit<typeof notes>) {
	const observed: Note[] = [];
	let live = 0;
	const wrapped: RowEdit<typeof notes> = {
		path: edit.path,
		get pending() {
			return edit.pending;
		},
		get locked() {
			return edit.locked;
		},
		subscribe(listener) {
			live++;
			const stop = edit.subscribe(listener);
			return () => {
				live--;
				stop();
			};
		},
		shown: (row) => edit.shown(row),
		change(row, change) {
			observed.push(row);
			return edit.change(row, change);
		},
		save: () => edit.save(),
		discard: () => edit.discard(),
		delete: () => edit.delete(),
	};
	return {
		edit: wrapped,
		observed,
		get live() {
			return live;
		},
	};
}

/** A title input over one row, as an app's detail view types it. */
function Title({ edit, row }: { edit: RowEdit<typeof notes>; row: Note }) {
	const note = useRowEdit(edit, row);
	return (
		<input
			value={note.row.issues === null ? note.row.fields.title : ''}
			disabled={note.locked}
			onChange={(event) =>
				note.change({ fields: { title: event.currentTarget.value } })
			}
		/>
	);
}

test('typing names what the committed render showed, an own save included, never what a suspended transition rendered', async () => {
	const { folder, other, read, observe } = await setup();
	const milk = recorded(folder.tables.notes.edit('milk'));
	const first = await observe('milk');
	const gate = Promise.withResolvers<void>();
	let setRow!: (row: Note) => void;
	function Gate({ row }: { row: Note }) {
		if (row !== first) use(gate.promise);
		return null;
	}
	function Detail() {
		const [row, set] = useState(first);
		setRow = set;
		return (
			<>
				<Title edit={milk.edit} row={row} />
				<Gate row={row} />
			</>
		);
	}
	const view = await mount(
		<Suspense fallback={<p>Loading</p>}>
			<Detail />
		</Suspense>,
	);
	// An own save lands; this view never reads again, and still shows it.
	await act(async () => type(view.input(), 'Mine'));
	await act(async () => folder.tables.notes.edit('milk').save());
	expect(folder.tables.notes.edit('milk').pending).toBeUndefined();
	expect(view.input().value).toBe('Mine');

	expectOk(
		await other.tables.notes.set('milk', await read('milk'), {
			fields: { done: true },
		}),
	);
	const second = await observe('milk');
	await act(async () => startTransition(() => setRow(second)));
	await act(async () => type(view.input(), 'Mine!'));
	expect(milk.observed.at(-1)?.fields).toEqual({ title: 'Mine', done: false });

	await act(async () => gate.resolve());
	await act(async () => type(view.input(), 'Mine!!'));
	// The committed render now shows the newer read, held input beside it.
	expect(milk.observed.at(-1)?.fields).toEqual({ title: 'Mine', done: true });
	expect(view.input().value).toBe('Mine!!');
	await act(async () => folder.tables.notes.edit('milk').save());
	expect((await read('milk')).fields).toEqual({ title: 'Mine!!', done: true });
});

test('closing the folder re-renders a view whose held input keeps the same pending value', async () => {
	const { folder, read, observe } = await setup();
	const edit = folder.tables.notes.edit('milk');
	const view = await mount(<Title edit={edit} row={await observe('milk')} />);
	await act(async () => type(view.input(), 'Oat milk'));
	const pending: RowPending | undefined = edit.pending;
	expect(pending).toBeDefined();
	expect(view.input().disabled).toBe(false);

	let closing!: Promise<unknown>;
	act(() => {
		closing = folder.close();
	});
	expect(edit.pending).toBe(pending);
	expect(view.input().disabled).toBe(true);

	await act(async () => {
		await closing;
	});
	expect(edit.pending).toBeUndefined();
	expect((await read('milk')).fields.title).toBe('Oat milk');
});

test('a reused view follows its path, and the row it left keeps its input', async () => {
	const { folder, observe } = await setup();
	const rows = { milk: await observe('milk'), bread: await observe('bread') };
	const views = {
		milk: recorded(folder.tables.notes.edit('milk')),
		bread: recorded(folder.tables.notes.edit('bread')),
	};
	const Shown = ({ id }: { id: 'milk' | 'bread' }) => (
		<Title edit={views[id].edit} row={rows[id]} />
	);
	const view = await mount(<Shown id="milk" />);
	await act(async () => type(view.input(), 'Oat milk'));

	await act(async () => view.root.render(<Shown id="bread" />));
	expect(view.input().value).toBe('Bread');
	await act(async () => type(view.input(), 'Rye'));

	expect(views.milk.live).toBe(0);
	expect(views.bread.live).toBeGreaterThan(0);
	expect(folder.tables.notes.edit('milk').pending?.fields).toEqual({
		title: 'Oat milk',
	});
	expect(folder.tables.notes.edit('bread').pending?.fields).toEqual({
		title: 'Rye',
	});
});

test('unmounting every view keeps the input and its timer with the folder', async () => {
	const { folder, read, observe } = await setup({ saveAfterMs: 50 });
	const milk = recorded(folder.tables.notes.edit('milk'));
	const view = await mount(
		<Title edit={milk.edit} row={await observe('milk')} />,
	);
	await act(async () => type(view.input(), 'Oat milk'));
	await act(async () => view.root.unmount());
	expect(milk.live).toBe(0);
	expect(folder.tables.notes.edit('milk').pending?.fields).toEqual({
		title: 'Oat milk',
	});

	while (folder.tables.notes.edit('milk').pending !== undefined)
		await Bun.sleep(5);
	expect((await read('milk')).fields.title).toBe('Oat milk');
});

test('the text binding shows held text over this render’s bytes, BOM kept', async () => {
	const { folder } = await setup();
	const path = 'notes/a.txt';
	expectOk(
		await folder.files.write(
			path,
			null,
			new TextEncoder().encode('﻿one\r\n'),
		),
	);
	const file = expectOk(await folder.files.read(path));
	const bytes = await fileBytes(file!.content);
	function Source({ folder }: { folder: Folder }) {
		const text = useTextEdit(folder.files.edit(path), bytes);
		return (
			<textarea
				value={text.text}
				onChange={(event) => text.change(event.currentTarget.value)}
			/>
		);
	}
	const view = await mount(<Source folder={folder} />);
	expect(view.input().value).toBe('﻿one\r\n');
	await act(async () => type(view.input(), '﻿one!\r\n'));
	await act(async () => folder.files.edit(path).save());

	const saved = expectOk(await folder.files.read(path));
	expect(await fileBytes(saved!.content)).toEqual(
		new TextEncoder().encode('﻿one!\r\n'),
	);
	// The view did not read again and shows its own save.
	expect(view.input().value).toBe('﻿one!\r\n');
});
