/**
 * Note Editor DOM Tests
 *
 * The CodeMirror editor over jsdom, alone and bound to a note held open in
 * the repository engine (`repository.test-support.ts`). jsdom has no
 * layout, so these prove the text, the decorations, the history and the
 * writes, not what a person sees; the Playwright tests cover that.
 *
 * Key behaviors:
 * - Opening a note and saving with no edit leaves the file byte-for-byte unchanged
 * - A local edit writes exactly the typed characters; an edit and its undo restore the file
 * - A change from elsewhere is applied as small changes: the cursor stays and Undo skips it
 * - CRLF bodies keep CRLF
 * - Live preview hides syntax off the cursor's line; a task checkbox toggles one character
 * - A conflict block is a card; resolving it is one edit that removes the markers
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { undo } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import { noteText, openDevice } from '../repository.test-support.js';
import { changesTo } from '@epicenter/svelte/codemirror';
import { conflictsIn, resolveConflict } from './conflicts.js';
import { createNoteEditor, type NoteEditor } from './note-editor.js';

// SAFETY: jsdom has no layout; the empty list supplies only the geometry CodeMirror asks for.
Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
// SAFETY: jsdom has no layout; this rectangle stands for an unmeasured range.
Range.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanups.splice(0).reverse()) await step();
	document.body.replaceChildren();
});

function editorOver(body: string, onEdit: (body: string) => void = () => {}): NoteEditor {
	const parent = document.createElement('div');
	document.body.append(parent);
	const editor = createNoteEditor({ parent, body, onEdit });
	cleanups.push(() => editor.destroy());
	return editor;
}

/** Type `text` at the cursor, as a person's input does. */
function type(editor: NoteEditor, text: string) {
	const { view } = editor;
	view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type' });
}

/** A note held open on a device, with the editor bound to it as NoteDetail binds it. */
async function boundNote(text: string) {
	const device = await openDevice({ 'notes/a.md': text });
	cleanups.push(() => device.close());
	const note = await device.repo.notes.open({ stem: 'a' });
	cleanups.push(() => note.close());
	let writes = 0;
	const edit = (body: string) => {
		writes++;
		void note.edit(body);
	};
	const editor = editorOver(note.read()?.body ?? '', edit);
	const stop = note.subscribe(() => editor.follow(note.read()?.body ?? ''));
	cleanups.push(stop);
	return { device, note, editor, edit, writes: () => writes };
}

// A note as another tool might have written it: comments, quoting, key order and spacing Honeycrisp would not choose.
const handwritten = [
	'---',
	'# written by hand',
	"title:   'Groceries'   # the shop",
	'createdAt: "2026-10-01T00:00:00.000Z"',
	'pinned: false',
	'folderId: ~',
	'deletedAt: null',
	'tags: [a,  b]',
	'---',
	'# List',
	'',
	'- [ ] milk  ',
	'- [x] **eggs**\t',
	'',
	'No newline at the end',
].join('\n');

test.each([
	['written by hand', handwritten],
	['with CRLF in its body', noteText({ body: 'one\r\n\r\n- [ ] two\r\n' })],
])('opening a note %s and saving with no edit leaves the file byte-for-byte unchanged', async (_, text) => {
	const { device, editor, edit, writes } = await boundNote(text);
	await device.repo.flush();
	expect(writes()).toBe(0);
	expect(device.text('notes/a.md')).toBe(text);
	// Saving what the editor holds, unchanged, writes the same bytes.
	edit(editor.view.state.sliceDoc());
	await device.repo.flush();
	expect(device.text('notes/a.md')).toBe(text);
});

test('a local edit writes exactly the typed characters, and its undo restores the file', async () => {
	const { device, editor } = await boundNote(handwritten);
	const at = editor.view.state.sliceDoc().indexOf('milk') + 'milk'.length;
	editor.view.dispatch({ selection: { anchor: at } });
	type(editor, ' and oat milk');
	await device.repo.flush();
	expect(device.text('notes/a.md')).toBe(handwritten.replace('milk  ', 'milk and oat milk  '));
	expect(undo(editor.view)).toBe(true);
	await device.repo.flush();
	expect(device.text('notes/a.md')).toBe(handwritten);
	// Typing more adds no batch: each write replaces the unsent one.
	const unsent = () => device.repo.query('SELECT count(*) AS n FROM "epicenter/outbox"');
	const before = await unsent();
	for (const letter of 'abc') type(editor, letter);
	await device.repo.flush();
	expect(await unsent()).toEqual(before);
});

test('a change from elsewhere keeps the cursor where it was and is not undone by Undo', async () => {
	const body = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';
	const { device, editor } = await boundNote(noteText({ body }));
	const end = 'Third paragraph'.length + body.indexOf('Third paragraph');
	editor.view.dispatch({ selection: { anchor: end } });
	type(editor, ' Mine');
	await device.repo.flush();
	// Their edit lands in the first paragraph, before the cursor.
	await device.theirs('notes/a.md', noteText({ body: body.replace('First paragraph.', 'First paragraph, theirs.').replace('Third paragraph.', 'Third paragraph Mine.') }));
	expect(editor.view.state.doc.toString()).toBe('First paragraph, theirs.\n\nSecond paragraph.\n\nThird paragraph Mine.\n');
	const head = editor.view.state.selection.main.head;
	expect(editor.view.state.doc.sliceString(head - 'Mine'.length, head)).toBe('Mine');
	expect(undo(editor.view)).toBe(true);
	expect(editor.view.state.doc.toString()).toBe('First paragraph, theirs.\n\nSecond paragraph.\n\nThird paragraph.\n');
});

test('changes from elsewhere are the smallest edits, in document positions', () => {
	const editor = editorOver('one\ntwo\nthree\n');
	expect(changesTo(editor.view.state, 'one\ntwo!\nthree\n')).toEqual([{ from: 7, to: 7, insert: '!' }]);
	const crlf = editorOver('one\r\ntwo\r\n');
	expect(crlf.view.state.doc.lines).toBe(3);
	expect(changesTo(crlf.view.state, 'one\r\nTWO\r\n')).toEqual([{ from: 4, to: 7, insert: 'TWO' }]);
});

test('a CRLF body keeps its CRLF line breaks through edits', () => {
	let written = '';
	const editor = editorOver('one\r\ntwo\r\n', (body) => (written = body));
	editor.view.dispatch({ selection: { anchor: 3 } });
	// Enter inserts the document's own line break.
	editor.view.dispatch(editor.view.state.replaceSelection(`${editor.view.state.lineBreak}1`), { userEvent: 'input.type' });
	expect(written).toBe('one\r\n1\r\ntwo\r\n');
});

test('live preview hides syntax off the cursor line and shows it on the line being edited', () => {
	const editor = editorOver('# Title\n\nSome **bold** text\n');
	const lines = () => [...editor.view.contentDOM.querySelectorAll('.cm-line')].map((line) => line.textContent);
	editor.view.dispatch({ selection: { anchor: 0 } });
	expect(lines()).toEqual(['# Title', '', 'Some bold text', '']);
	expect(editor.view.contentDOM.querySelector('.cm-md-h1')).not.toBeNull();
	expect(editor.view.contentDOM.querySelector('.cm-md-strong')?.textContent).toBe('bold');
	editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length - 3 } });
	expect(lines()).toEqual(['Title', '', 'Some **bold** text', '']);
});

test('a task checkbox toggles exactly the character inside its brackets', () => {
	let written = '';
	const editor = editorOver('- [ ] milk\n- [x] eggs\n\nend', (body) => (written = body));
	editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
	const boxes = [...editor.view.contentDOM.querySelectorAll<HTMLInputElement>('input.cm-md-task')];
	expect(boxes.map((box) => box.checked)).toEqual([false, true]);
	boxes[0]?.click();
	expect(written).toBe('- [x] milk\n- [x] eggs\n\nend');
});

const conflicted = [
	'Before.',
	'<<<<<<< current alice 2026-10-28T12:00:00Z 1111111',
	'Hers.',
	'\\=======',
	'||||||| base 2222222',
	'Original.',
	'=======',
	'His.',
	'>>>>>>> incoming bob 2026-10-28T12:01:00Z 3333333',
	'After.',
	'',
].join('\n');

test('a conflict block renders as one card and resolving it is one edit that removes the markers', () => {
	const writes: string[] = [];
	const editor = editorOver(conflicted, (body) => writes.push(body));
	const [conflict] = conflictsIn(editor.view.state);
	// A section line that reads as a delimiter is escaped in the file and shown, and kept, as written.
	expect(conflict).toMatchObject({ current: 'Hers.\n=======\n', incoming: 'His.\n', labels: ['alice, 2026-10-28T12:00:00Z', 'bob, 2026-10-28T12:01:00Z'] });
	const card = editor.view.dom.querySelector('[aria-label="Overlapping edits"]');
	expect(card?.textContent).toContain('Keep both');
	expect(editor.view.contentDOM.textContent).not.toContain('<<<<<<<');
	const keepBoth = [...(card?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Keep both');
	keepBoth?.click();
	expect(writes).toEqual(['Before.\nHers.\n=======\nHis.\nAfter.\n']);
	expect(conflictsIn(editor.view.state)).toEqual([]);
	// Undo brings the block back, whole.
	undo(editor.view);
	expect(editor.view.state.doc.toString()).toBe(conflicted);
	expect(resolveConflict(editor.view, conflict?.from ?? -1, 'that')).toBe(true);
	expect(editor.view.state.doc.toString()).toBe('Before.\nHis.\nAfter.\n');
	editor.view.dispatch({ selection: EditorSelection.cursor(0) });
});
