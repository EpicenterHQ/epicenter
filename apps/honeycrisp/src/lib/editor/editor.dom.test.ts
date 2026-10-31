/**
 * Note Editor DOM Tests
 *
 * The CodeMirror editor over jsdom, alone and bound to a note's body as
 * `NoteDetail` binds it (`fieldEdit` over a stand-in client: a real device
 * client in a temporary directory, in place of the repository). jsdom has no layout, so these prove the text, the
 * decorations, the history and the writes, not what a person sees; the
 * Playwright suite covers that.
 *
 * Key behaviors:
 * - A local edit writes exactly the typed characters into the note's file
 * - A change from elsewhere is applied as small changes: the cursor stays and Undo skips it
 * - CRLF bodies keep CRLF
 * - Live preview hides syntax off the cursor's line; a task checkbox toggles one character
 * - A conflict block is a card; resolving it is one edit that removes the markers
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { openDevice } from '@epicenter/folder/node';
import { honeycrisp } from '../contract.js';
import { changesTo } from './binding.js';
import { conflictsIn, resolveConflict } from './conflicts.js';
import { createNoteEditor, type NoteEditor } from './note-editor.js';

const { fromClient } = await import('@epicenter/svelte/client');
const { flushSync, mount, unmount } = await import('svelte');
const { default: BodyHost } = await import('./body-host.test-support.svelte');

// SAFETY: jsdom has no layout; the empty list supplies only the geometry CodeMirror asks for.
Range.prototype.getClientRects ??= () =>
	({
		length: 0,
		item: () => null,
		[Symbol.iterator]: function* () {},
	}) as unknown as DOMRectList;
// SAFETY: jsdom has no layout; this rectangle stands for an unmeasured range.
Range.prototype.getBoundingClientRect ??= () =>
	({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanups.splice(0).reverse()) await step();
	document.body.replaceChildren();
});

function editorOver(
	body: string,
	onEdit: (body: string) => void = () => {},
): NoteEditor {
	const parent = document.createElement('div');
	document.body.append(parent);
	const editor = createNoteEditor({ parent, body, onEdit });
	cleanups.push(() => editor.destroy());
	return editor;
}

/** Type `text` at the cursor, as a person's input does. */
function type(view: EditorView, text: string) {
	view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type' });
}

/** Wait, flushing Svelte's effects, until `done` holds. */
async function until(done: () => boolean | Promise<boolean>) {
	for (let turn = 0; turn < 400; turn++) {
		flushSync();
		if (await done()) return;
		await Bun.sleep(5);
	}
	throw new Error('timed out');
}

/** A note on a device in a temporary directory, with the editor bound to its body. */
async function boundNote(text: string) {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-honeycrisp-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const file = join(root, 'notes/a.md');
	const device = openDevice(honeycrisp, { path: root });
	const written = await device.notes.create({
		id: 'a',
		createdAt: '2026-10-31T12:00:00.000Z',
	});
	if (written.error !== null) throw written.error;
	await writeFile(file, text);
	const target = document.createElement('div');
	document.body.append(target);
	const host = mount(BodyHost, {
		target,
		props: { notes: fromClient(device).notes, id: 'a' },
	});
	cleanups.push(() => unmount(host));
	let view: EditorView | null = null;
	await until(() => {
		const dom = target.querySelector<HTMLElement>('.cm-editor');
		view = dom && EditorView.findFromDOM(dom);
		return view?.state.doc.toString() === text.split('---\n')[2];
	});
	return { view: view as unknown as EditorView, file };
}

/** A note as Honeycrisp writes it (house style), so a write changes only its body. */
const note = (body: string) =>
	`---\ncreatedAt: "2026-10-31T12:00:00.000Z"\n---\n${body}`;

test('a local edit writes exactly the typed characters into the note', async () => {
	const { view, file } = await boundNote(note('# List\n\n- [ ] milk\n'));
	const before = note('# List\n\n- [ ] milk\n');
	view.dispatch({ selection: { anchor: '# List\n\n- [ ] milk'.length } });
	for (const letter of ' and oat milk') type(view, letter);
	await until(
		async () =>
			(await readFile(file, 'utf8')) ===
			before.replace('- [ ] milk', '- [ ] milk and oat milk'),
	);
});

test('a change from elsewhere keeps the cursor where it was and is not undone by Undo', async () => {
	const body = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';
	const { view, file } = await boundNote(note(body));
	view.dispatch({
		selection: { anchor: body.indexOf('Third paragraph.') + 15 },
	});
	type(view, ' Mine');
	const mine = body.replace('Third paragraph.', 'Third paragraph Mine.');
	await until(async () => (await readFile(file, 'utf8')).endsWith(mine));
	// Another program's edit lands in the first paragraph, before the cursor.
	await writeFile(
		file,
		note(mine.replace('First paragraph.', 'First paragraph, theirs.')),
	);
	await until(() =>
		view.state.doc.toString().startsWith('First paragraph, theirs.'),
	);
	expect(view.state.doc.toString()).toBe(
		'First paragraph, theirs.\n\nSecond paragraph.\n\nThird paragraph Mine.\n',
	);
	const head = view.state.selection.main.head;
	expect(view.state.doc.sliceString(head - 'Mine'.length, head)).toBe('Mine');
	expect(undo(view)).toBe(true);
	expect(view.state.doc.toString()).toBe(
		'First paragraph, theirs.\n\nSecond paragraph.\n\nThird paragraph.\n',
	);
});

test('changes from elsewhere are the smallest edits, in document positions', () => {
	const editor = editorOver('one\ntwo\nthree\n');
	expect(changesTo(editor.view.state, 'one\ntwo!\nthree\n')).toEqual([
		{ from: 7, to: 7, insert: '!' },
	]);
	const crlf = editorOver('one\r\ntwo\r\n');
	expect(crlf.view.state.doc.lines).toBe(3);
	expect(changesTo(crlf.view.state, 'one\r\nTWO\r\n')).toEqual([
		{ from: 4, to: 7, insert: 'TWO' },
	]);
});

test('a CRLF body keeps its CRLF line breaks through edits', () => {
	let written = '';
	const editor = editorOver('one\r\ntwo\r\n', (body) => (written = body));
	editor.view.dispatch({ selection: { anchor: 3 } });
	// Enter inserts the document's own line break.
	type(editor.view, `${editor.view.state.lineBreak}1`);
	expect(written).toBe('one\r\n1\r\ntwo\r\n');
});

test('live preview hides syntax off the cursor line and shows it on the line being edited', () => {
	const editor = editorOver('# Title\n\nSome **bold** text\n');
	const lines = () =>
		[...editor.view.contentDOM.querySelectorAll('.cm-line')].map(
			(line) => line.textContent,
		);
	editor.view.dispatch({ selection: { anchor: 0 } });
	expect(lines()).toEqual(['# Title', '', 'Some bold text', '']);
	expect(editor.view.contentDOM.querySelector('.cm-md-h1')).not.toBeNull();
	expect(
		editor.view.contentDOM.querySelector('.cm-md-strong')?.textContent,
	).toBe('bold');
	editor.view.dispatch({
		selection: { anchor: editor.view.state.doc.length - 3 },
	});
	expect(lines()).toEqual(['Title', '', 'Some **bold** text', '']);
});

test('a task checkbox toggles exactly the character inside its brackets', () => {
	let written = '';
	const editor = editorOver(
		'- [ ] milk\n- [x] eggs\n\nend',
		(body) => (written = body),
	);
	editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
	const boxes = [
		...editor.view.contentDOM.querySelectorAll<HTMLInputElement>(
			'input.cm-md-task',
		),
	];
	expect(boxes.map((box) => box.checked)).toEqual([false, true]);
	boxes[0]?.click();
	expect(written).toBe('- [x] milk\n- [x] eggs\n\nend');
});

// A block as Epicenter's merge writes it (`block` in `@epicenter/definition/merge`).
const conflicted = [
	'Before.',
	'<<<<<<< current alice/laptop 2026-10-28T14:02:11Z 3f2a1c9',
	'Hers.',
	'||||||| base 9b8e7d6',
	'Original.',
	'=======',
	'His.',
	'>>>>>>> incoming bob/phone 2026-10-28T14:02:12Z 1a2b3c4',
	'After.',
	'',
].join('\n');

test('a conflict block renders as one card and resolving it is one edit that removes the markers', () => {
	const writes: string[] = [];
	const editor = editorOver(conflicted, (body) => writes.push(body));
	const [conflict] = conflictsIn(editor.view.state);
	expect(conflict).toMatchObject({
		current: 'Hers.\n',
		incoming: 'His.\n',
		labels: ['alice/laptop', 'bob/phone'],
	});
	const card = editor.view.dom.querySelector(
		'[aria-label="Overlapping edits"]',
	);
	expect(card?.textContent).toContain('alice/laptop');
	expect(editor.view.contentDOM.textContent).not.toContain('<<<<<<<');
	const keepBoth = [...(card?.querySelectorAll('button') ?? [])].find(
		(button) => button.textContent === 'Keep both',
	);
	keepBoth?.click();
	expect(writes).toEqual(['Before.\nHers.\nHis.\nAfter.\n']);
	expect(conflictsIn(editor.view.state)).toEqual([]);
	// Undo brings the block back, whole.
	undo(editor.view);
	expect(editor.view.state.doc.toString()).toBe(conflicted);
	expect(resolveConflict(editor.view, conflict?.from ?? -1, 'that')).toBe(true);
	expect(editor.view.state.doc.toString()).toBe('Before.\nHis.\nAfter.\n');
});
