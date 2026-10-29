/**
 * Note Editor DOM Tests
 *
 * The CodeMirror view of a note's body over jsdom, bound to the note's
 * repository editor on a replica in this process (`repository.test-support.ts`).
 * jsdom has no layout, so these prove the text, the decorations, the
 * history and the writes, not what a person sees; the Playwright tests
 * cover that.
 *
 * Key behaviors:
 * - Opening a note and leaving it unedited leaves the file byte-for-byte unchanged
 * - A local edit writes exactly the typed characters; an edit and its undo restore the file
 * - A change from elsewhere is applied in place: the cursor stays and Undo skips it
 * - Live preview hides syntax off the cursor's line; a task checkbox toggles one character
 * - A conflict block is a card; resolving it is one edit that removes the markers
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { undo } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import { bodyOf } from '@epicenter/repository/api';
import { expectOk } from 'wellcrafted/testing';
import { noteText, openDevice, until } from '../repository.test-support.js';
import { conflictsIn, resolveConflict } from './conflicts.js';
import { createNoteEditor } from './note-editor.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanups.splice(0).reverse()) await step();
	document.body.replaceChildren();
});

/** The note `notes/a.md` with `text`, its editor open and a body view bound to it, as NoteDetail binds it. */
async function boundNote(text: string) {
	const device = await openDevice({ 'notes/a.md': text });
	cleanups.push(() => device.close());
	const repo = expectOk(await device.open());
	await until(() => repo.status().status === 'open', 'the repository');
	const editor = expectOk(await repo.notes.openEditor({ stem: 'a' }));
	cleanups.push(() => editor.discard());
	const parent = document.createElement('div');
	document.body.append(parent);
	const { view, destroy } = createNoteEditor({ parent, editor });
	cleanups.push(destroy);
	/** Once every keystroke so far is stored. */
	const saved = () => until(() => editor.state().status === 'saved' && device.text('notes/a.md') === editor.draft(), 'the editor to save');
	return { device, editor, view, saved, body: () => bodyOf(editor.draft()) };
}

/** A note with Honeycrisp's fields over `body`, its editor open. */
const editorOver = (body: string) => boundNote(noteText({ body }));

/** Type `text` at the cursor, as a person's input does. */
function type(view: Awaited<ReturnType<typeof boundNote>>['view'], text: string) {
	view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type' });
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

test('opening a note written by hand and leaving it unedited leaves the file byte-for-byte unchanged', async () => {
	const { device, editor, view } = await boundNote(handwritten);
	expect(view.state.doc.toString()).toBe(bodyOf(handwritten));
	// Telling the editor what it already holds writes nothing.
	editor.update(editor.draft());
	await Bun.sleep(5);
	expect(editor.state()).toEqual({ status: 'saved' });
	expect(device.text('notes/a.md')).toBe(handwritten);
});

test('a local edit writes exactly the typed characters, and its undo restores the file', async () => {
	const { device, view, saved } = await boundNote(handwritten);
	const at = view.state.sliceDoc().indexOf('milk') + 'milk'.length;
	view.dispatch({ selection: { anchor: at } });
	type(view, ' and oat milk');
	await saved();
	expect(device.text('notes/a.md')).toBe(handwritten.replace('milk  ', 'milk and oat milk  '));
	expect(undo(view)).toBe(true);
	await saved();
	expect(device.text('notes/a.md')).toBe(handwritten);
});

test('a change from elsewhere keeps the cursor where it was and is not undone by Undo', async () => {
	const body = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';
	const { device, view, saved } = await boundNote(noteText({ body }));
	const end = 'Third paragraph'.length + body.indexOf('Third paragraph');
	view.dispatch({ selection: { anchor: end } });
	type(view, ' Mine');
	await saved();
	// Their edit lands in the first paragraph, before the cursor.
	device.theirs('notes/a.md', noteText({ body: body.replace('First paragraph.', 'First paragraph, theirs.').replace('Third paragraph.', 'Third paragraph Mine.') }));
	await until(() => view.state.doc.toString() === 'First paragraph, theirs.\n\nSecond paragraph.\n\nThird paragraph Mine.\n', 'their edit in the view');
	const head = view.state.selection.main.head;
	expect(view.state.doc.sliceString(head - 'Mine'.length, head)).toBe('Mine');
	expect(undo(view)).toBe(true);
	expect(view.state.doc.toString()).toBe('First paragraph, theirs.\n\nSecond paragraph.\n\nThird paragraph.\n');
});

test('live preview hides syntax off the cursor line and shows it on the line being edited', async () => {
	const { view } = await editorOver('# Title\n\nSome **bold** text\n');
	const lines = () => [...view.contentDOM.querySelectorAll('.cm-line')].map((line) => line.textContent);
	view.dispatch({ selection: { anchor: 0 } });
	expect(lines()).toEqual(['# Title', '', 'Some bold text', '']);
	expect(view.contentDOM.querySelector('.cm-md-h1')).not.toBeNull();
	expect(view.contentDOM.querySelector('.cm-md-strong')?.textContent).toBe('bold');
	view.dispatch({ selection: { anchor: view.state.doc.length - 3 } });
	expect(lines()).toEqual(['Title', '', 'Some **bold** text', '']);
});

test('a task checkbox toggles exactly the character inside its brackets', async () => {
	const { view, body, saved, device } = await editorOver('- [ ] milk\n- [x] eggs\n\nend');
	view.dispatch({ selection: { anchor: view.state.doc.length } });
	const boxes = [...view.contentDOM.querySelectorAll<HTMLInputElement>('input.cm-md-task')];
	expect(boxes.map((box) => box.checked)).toEqual([false, true]);
	boxes[0]?.click();
	expect(body()).toBe('- [x] milk\n- [x] eggs\n\nend');
	await saved();
	expect(device.text('notes/a.md')).toBe(noteText({ body: '- [x] milk\n- [x] eggs\n\nend' }));
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

test('a conflict block renders as one card and resolving it is one edit that removes the markers', async () => {
	const { view, body } = await editorOver(conflicted);
	const editor = { view };
	const [conflict] = conflictsIn(editor.view.state);
	// A section line that reads as a delimiter is escaped in the file and shown, and kept, as written.
	expect(conflict).toMatchObject({ current: 'Hers.\n=======\n', incoming: 'His.\n', labels: ['alice, 2026-10-28T12:00:00Z', 'bob, 2026-10-28T12:01:00Z'] });
	const card = editor.view.dom.querySelector('[aria-label="Overlapping edits"]');
	expect(card?.textContent).toContain('Keep both');
	expect(editor.view.contentDOM.textContent).not.toContain('<<<<<<<');
	const keepBoth = [...(card?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Keep both');
	keepBoth?.click();
	expect(body()).toBe('Before.\nHers.\n=======\nHis.\nAfter.\n');
	expect(conflictsIn(editor.view.state)).toEqual([]);
	// Undo brings the block back, whole.
	undo(editor.view);
	expect(editor.view.state.doc.toString()).toBe(conflicted);
	expect(resolveConflict(editor.view, conflict?.from ?? -1, 'that')).toBe(true);
	expect(editor.view.state.doc.toString()).toBe('Before.\nHis.\nAfter.\n');
	editor.view.dispatch({ selection: EditorSelection.cursor(0) });
});
