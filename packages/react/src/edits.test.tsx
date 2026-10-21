/**
 * React Edit Binding Tests
 *
 * Mounts real React 19 roots in happy-dom over a real browser folder on an
 * in-memory IndexedDB, and types through the DOM handlers React committed.
 *
 * Key behaviors:
 * - A view reads the row the first time it mounts with nothing known, and
 *   tells loading, a missing row and a failed read apart
 * - An own save shows without a reread, another handle's change is read for
 *   the view showing it, and typing keeps both
 * - A body typed in the committed render's handler keeps a change the same
 *   event made through another handler
 * - Closing the folder re-renders a view whose held input keeps the same
 *   pending value, because the input fence is its own snapshot
 * - A reused view follows its path, and the row it left keeps its input
 * - Unmounting every view lets go of its subscriptions while the input and
 *   its timer stay with the folder
 * - The text binding shows held text over the stored file, BOM kept
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import type { FolderTable } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import type { FileEdit, Pending } from '@epicenter/folder/edits';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { useFileEdit } from './edits.js';

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
				body: 'one\ntwo\n',
			}),
		);
	const other = expectOk(await openFolder({ tables: { notes } }));
	cleanup.push(() => other.close());
	const read = async (id: string) => {
		const row = expectOk(await other.tables.notes.get(id));
		if (row === undefined) throw new Error(`${id} is not stored`);
		return row;
	};
	return { folder, other, read };
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
		container,
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

/** Wait until `done`, letting React and the folder run between checks. */
async function until(done: () => boolean) {
	for (let turn = 0; turn < 200; turn++) {
		if (done()) return;
		await act(async () => Bun.sleep(5));
	}
	throw new Error('Never happened');
}

/** `table`, counting each edit's live subscriptions and reads. */
function recorded(table: Notes) {
	const live: Record<string, number> = {};
	const reads: Record<string, number> = {};
	const edits = new Map<string, FileEdit<typeof notes>>();
	const wrapped: Notes = {
		...table,
		edit(id) {
			let wrappedEdit = edits.get(id);
			if (wrappedEdit !== undefined) return wrappedEdit;
			const edit = table.edit(id);
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
				read() {
					reads[id] = (reads[id] ?? 0) + 1;
					return edit.read();
				},
			};
			edits.set(id, wrappedEdit);
			return wrappedEdit;
		},
	};
	return { table: wrapped, live, reads };
}

/** A title input over one row, as an app's detail view types it. */
function Title({ table, id }: { table: Notes; id: string }) {
	const note = useFileEdit(table.edit(id));
	const row = note.getMarkdown();
	const { known, error } = note.getReadStatus();
	if (error !== undefined) return <p>{error.message}</p>;
	if (known === 'nothing') return <p>Loading</p>;
	if (row === undefined) return <p>Missing</p>;
	return (
		<input
			value={row.issues === null ? row.fields.title : ''}
			disabled={note.isLocked()}
			onChange={(event) =>
				note.change({ fields: { title: event.currentTarget.value } })
			}
		/>
	);
}

test('a view reads its row when it mounts with nothing known, and tells loading from missing', async () => {
	const { folder } = await setup();
	const notesTable = recorded(folder.tables.notes);
	const milk = await mount(<Title table={notesTable.table} id="milk" />);
	const ghost = await mount(<Title table={notesTable.table} id="ghost" />);
	await until(() => milk.container.textContent !== 'Loading');
	await until(() => ghost.container.textContent !== 'Loading');
	expect(milk.input().value).toBe('Milk');
	expect(ghost.container.textContent).toBe('Missing');
	expect(notesTable.reads).toEqual({ milk: 1, ghost: 1 });

	// A view of a row a list already answered reads nothing.
	expectOk(await folder.tables.notes.list());
	await mount(<Title table={notesTable.table} id="bread" />);
	expect(notesTable.reads.bread).toBeUndefined();
});

test('a failed first read waits for an explicit read: renders after it read nothing', async () => {
	const { folder } = await setup();
	const notesTable = recorded(folder.tables.notes);
	const get = IDBObjectStore.prototype.get;
	IDBObjectStore.prototype.get = () => {
		throw new DOMException('The disk is gone', 'UnknownError');
	};
	cleanup.push(() => {
		IDBObjectStore.prototype.get = get;
	});
	const view = await mount(<Title table={notesTable.table} id="milk" />);
	await act(async () => Bun.sleep(30));
	await act(async () => Bun.sleep(30));
	expect(notesTable.reads).toEqual({ milk: 1 });
	expect(view.container.textContent).toContain('Repository read failed');

	IDBObjectStore.prototype.get = get;
	await act(async () => {
		expectOk(await folder.tables.notes.edit('milk').read());
	});
	expect(view.input().value).toBe('Milk');
	expect(notesTable.reads).toEqual({ milk: 1 });
});

test('a view that shows only held input or the fence reads nothing', async () => {
	const { folder } = await setup();
	const notesTable = recorded(folder.tables.notes);
	function Status() {
		const note = useFileEdit(notesTable.table.edit('milk'));
		return (
			<p>
				{note.getPending() === undefined && !note.isLocked() ? 'Saved' : 'Held'}
			</p>
		);
	}
	const view = await mount(<Status />);
	await act(async () => Bun.sleep(5));
	expect(view.container.textContent).toBe('Saved');
	expect(notesTable.reads).toEqual({});
	expect(folder.tables.notes.edit('milk').getReadStatus().known).toBe(
		'nothing',
	);
});

test('an own save shows without a reread, an outside change is read for the view, and typing keeps both', async () => {
	const { folder, other, read } = await setup();
	const notesTable = recorded(folder.tables.notes);
	const view = await mount(<Title table={notesTable.table} id="milk" />);
	await until(() => view.container.querySelector('input') !== null);
	await act(async () => type(view.input(), 'Mine'));
	await act(async () => folder.tables.notes.edit('milk').save());
	expect(folder.tables.notes.edit('milk').getPending()).toBeUndefined();
	expect(view.input().value).toBe('Mine');
	expect(notesTable.reads.milk).toBe(1);

	expectOk(
		await other.tables.notes.set('milk', await read('milk'), {
			fields: { done: true },
		}),
	);
	await until(
		() => folder.tables.notes.edit('milk').getMarkdown()?.fields.done === true,
	);
	await act(async () => type(view.input(), 'Mine!'));
	expect(view.input().value).toBe('Mine!');
	await act(async () => folder.tables.notes.edit('milk').save());
	expect((await read('milk')).fields).toEqual({ title: 'Mine!', done: true });
});

test('a body typed in the committed render keeps a change the same event made through another handler', async () => {
	const { folder, read } = await setup();
	expectOk(await folder.tables.notes.list());
	function Body() {
		const note = useFileEdit(folder.tables.notes.edit('milk'));
		return (
			<section
				onChangeCapture={() =>
					// Another handler of the same event changes the first line.
					folder.tables.notes.edit('milk').change({ body: 'ONE\ntwo\n' })
				}
			>
				<textarea
					value={note.getMarkdown()?.body ?? ''}
					onChange={(event) => note.change({ body: event.currentTarget.value })}
				/>
			</section>
		);
	}
	const view = await mount(<Body />);
	expect(view.input().value).toBe('one\ntwo\n');
	await act(async () => type(view.input(), 'one\nTWO\n'));
	expect(view.input().value).toBe('ONE\nTWO\n');
	await act(async () => folder.tables.notes.edit('milk').save());
	expect((await read('milk')).body).toBe('ONE\nTWO\n');
});

test('closing the folder re-renders a view whose held input keeps the same pending value', async () => {
	const { folder, read } = await setup();
	expectOk(await folder.tables.notes.list());
	const edit = folder.tables.notes.edit('milk');
	const view = await mount(<Title table={folder.tables.notes} id="milk" />);
	await act(async () => type(view.input(), 'Oat milk'));
	const pending: Pending | undefined = edit.getPending();
	expect(pending).toBeDefined();
	expect(view.input().disabled).toBe(false);

	let closing!: Promise<unknown>;
	act(() => {
		closing = folder.close();
	});
	expect(edit.getPending()).toBe(pending);
	expect(view.input().disabled).toBe(true);

	await act(async () => {
		await closing;
	});
	expect(edit.getPending()).toBeUndefined();
	expect((await read('milk')).fields.title).toBe('Oat milk');
});

test('a reused view follows its path, and the row it left keeps its input', async () => {
	const { folder } = await setup();
	expectOk(await folder.tables.notes.list());
	const notesTable = recorded(folder.tables.notes);
	const view = await mount(<Title table={notesTable.table} id="milk" />);
	await act(async () => type(view.input(), 'Oat milk'));

	await act(async () =>
		view.root.render(<Title table={notesTable.table} id="bread" />),
	);
	expect(view.input().value).toBe('Bread');
	await act(async () => type(view.input(), 'Rye'));

	expect(notesTable.live.milk).toBe(0);
	expect(notesTable.live.bread).toBeGreaterThan(0);
	expect(folder.tables.notes.edit('milk').getPending()).toMatchObject({
		fields: { title: 'Oat milk' },
	});
	expect(folder.tables.notes.edit('bread').getPending()).toMatchObject({
		fields: { title: 'Rye' },
	});
});

test('unmounting every view keeps the input and its timer with the folder', async () => {
	const { folder, read } = await setup({ saveAfterMs: 50 });
	expectOk(await folder.tables.notes.list());
	const notesTable = recorded(folder.tables.notes);
	const view = await mount(<Title table={notesTable.table} id="milk" />);
	await act(async () => type(view.input(), 'Oat milk'));
	await act(async () => view.root.unmount());
	expect(notesTable.live.milk).toBe(0);
	expect(folder.tables.notes.edit('milk').getPending()).toMatchObject({
		fields: { title: 'Oat milk' },
	});

	while (folder.tables.notes.edit('milk').getPending() !== undefined)
		await Bun.sleep(5);
	expect((await read('milk')).fields.title).toBe('Oat milk');
});

test('the text binding shows held text over the stored file, BOM kept', async () => {
	const { folder } = await setup();
	const path = 'notes/a.txt';
	expectOk(
		await folder.files.write(path, null, new TextEncoder().encode('﻿one\r\n')),
	);
	function Source({ folder }: { folder: Folder }) {
		const text = useFileEdit(folder.files.edit(path));
		return (
			<textarea
				value={text.getText() ?? ''}
				onChange={(event) => text.replaceText(event.currentTarget.value)}
			/>
		);
	}
	const view = await mount(<Source folder={folder} />);
	await until(() => view.input().value !== '');
	expect(view.input().value).toBe('﻿one\r\n');
	await act(async () => type(view.input(), '﻿one!\r\n'));
	await act(async () => folder.files.edit(path).save());

	const saved = expectOk(await folder.files.read(path));
	expect(new Uint8Array(await saved!.content.arrayBuffer())).toEqual(
		new TextEncoder().encode('﻿one!\r\n'),
	);
	// The view did not read again and shows its own save.
	expect(view.input().value).toBe('﻿one!\r\n');
});

test('source typed in one handler keeps a field changed by another handler of the same event', async () => {
	const { folder, read } = await setup();
	expectOk(await folder.tables.notes.list());
	function Source() {
		const fileEdit = useFileEdit(folder.tables.notes.edit('milk'));
		return (
			<section
				onChangeCapture={() =>
					folder.tables.notes.edit('milk').change({ fields: { done: true } })
				}
			>
				<textarea
					value={fileEdit.getText() ?? ''}
					onChange={(event) => fileEdit.replaceText(event.currentTarget.value)}
				/>
			</section>
		);
	}
	const view = await mount(<Source />);
	await act(async () =>
		type(view.input(), view.input().value.replace('two', 'TWO')),
	);
	expect(view.input().value).toContain('done: true');
	expect(view.input().value).toContain('one\nTWO\n');
	await act(async () => folder.tables.notes.edit('milk').save());
	expect((await read('milk')).fields.done).toBe(true);
	expect((await read('milk')).body).toBe('one\nTWO\n');
});

test('independent frontmatter additions in one event preserve both fields in one header', async () => {
	const { folder } = await setup();
	const path = 'plain.md';
	expectOk(await folder.files.write(path, null, 'body\n'));
	expectOk(await folder.files.edit(path).read());
	function Source() {
		const fileEdit = useFileEdit(folder.files.edit(path));
		return (
			<section
				onChangeCapture={() =>
					folder.files.edit(path).change({ fields: { a: 1 } })
				}
			>
				<textarea
					value={fileEdit.getText() ?? ''}
					onChange={(event) => fileEdit.replaceText(event.currentTarget.value)}
				/>
			</section>
		);
	}
	const view = await mount(<Source />);
	await act(async () => type(view.input(), '---\nb: 2\n---\nbody\n'));
	const markdown = folder.files.edit(path).getMarkdown();
	expect(markdown?.fields).toEqual({ a: 1, b: 2 });
	expect(markdown?.body).toBe('body\n');
	expect(markdown?.issues).toBeNull();
	await act(async () => folder.files.edit(path).save());
	expect(folder.files.edit(path).getMarkdown()?.fields).toEqual({ a: 1, b: 2 });
});
