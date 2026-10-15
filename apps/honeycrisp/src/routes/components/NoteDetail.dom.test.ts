/**
 * Note View Tests
 *
 * Mounts the real note view, `NoteDetail`, with its rich-text editor and UI
 * library, inside the query client the layout provides, over the real notes
 * state on the in-memory OPFS stand-in. Events are delivered to the DOM the
 * view renders; jsdom has no layout, focus, selection, or IME, so these show
 * what a delivered event does, not that a person can type there.
 *
 * Key behaviors:
 * - Typing a title writes it, and switching between rich text and Source or
 *   typing a title keeps the one rich-text view
 * - Rich-text typing reaches the cache through ProseMirror's own DOM reading,
 *   is written, and stays undoable after the write lands
 * - Different Source text replaces the rich-text document
 * - A write that meets a change made elsewhere merges with it; the edit
 *   wins where both changed
 * - Returning to the window shows a change made elsewhere
 * - Once the notes are closing, the controls take no input, and the
 *   rich-text view stays mounted
 */
import '../../lib/dom.test-support.ts';
import { afterEach, expect, test } from 'bun:test';
import { click, type } from '../../lib/dom.test-support.ts';
import {
	noteText,
	openNotesFolder,
	until,
} from '../../lib/folder.test-support.js';
import type { WriteFailure } from '../../lib/notes.svelte.js';
import {
	createQueryClient,
	focusManager,
	quiet,
} from '../../lib/query.test-support.js';

// jsdom has no layout, and its ranges cannot be measured. ProseMirror
// measures the cursor to scroll it into view after typing; it gets no boxes.
Range.prototype.getClientRects ??= () =>
	[] as unknown as ReturnType<Range['getClientRects']>;
Range.prototype.getBoundingClientRect ??= () =>
	({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

const { flushSync, mount, unmount } = await import('svelte');
const { createNotes } = await import('../../lib/notes.svelte.ts');
const { default: NoteDetail } = await import('./NoteDetail.svelte');
const { default: Host } = await import('../../lib/ui-host.test-support.svelte');

const PATH = 'notes/a.md';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

/** Note `a` open in the notes state, and its view mounted as the page renders it. */
async function view() {
	const fixture = await openNotesFolder();
	await fixture.write(PATH, noteText({ title: 'Alpha' }));
	const failures: WriteFailure[] = [];
	const notes = createNotes(fixture.host, createQueryClient(), {
		onWriteFailed: (failure) => failures.push(failure),
	});
	cleanup.push(() => notes.close());
	await notes.load();
	notes.open(PATH);
	const target = document.createElement('div');
	document.body.append(target);
	const host = mount(Host, {
		target,
		props: {
			client: notes.queryClient,
			component: NoteDetail as never,
			props: { notes, path: PATH },
		},
	});
	cleanup.push(() => {
		unmount(host);
		flushSync();
		target.remove();
	});
	await settle();
	/** Let every write and the reads after them land, then render. */
	async function settle() {
		await quiet(notes);
		flushSync();
		await tick();
	}
	return { ...fixture, notes, failures, target, settle };
}

function only<T extends Element>(target: ParentNode, selector: string): T {
	const found = target.querySelector<T>(selector);
	if (found === null) throw new Error(`Nothing matches ${selector}`);
	return found;
}

/** Let a binding's after-input check run, then render. */
async function tick() {
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

/**
 * Type into the rich-text view the way the browser reports typing: change the
 * text in its paragraph and let ProseMirror's observer read the change.
 */
async function typeRich(rich: HTMLElement, text: string) {
	const line = rich.querySelector('p')?.firstChild;
	if (!(line instanceof Text)) throw new Error('No text to type into');
	line.data += text;
	await tick();
}

const richOf = (target: ParentNode) =>
	only<HTMLElement>(target, '[aria-label="Note text"]');
const titleOf = (target: ParentNode) =>
	only<HTMLInputElement>(target, 'input[aria-label="Title"]');
const undoButton = (target: ParentNode) =>
	only<HTMLButtonElement>(target, 'button[aria-label="Undo"]');

test('typing a title writes it, and switching tabs or typing keeps the one rich-text view', async () => {
	const { target, text, settle } = await view();
	const rich = richOf(target);
	click(target, 'Source');
	flushSync();
	click(target, 'Rich text');
	flushSync();
	expect(richOf(target)).toBe(rich);
	type(titleOf(target), 'Retitled');
	await tick();
	await settle();
	expect(text(PATH)).toContain('title: Retitled');
	expect(target.textContent).toMatch(/Saved to\s*notes\/a\.md/);
	expect(richOf(target)).toBe(rich);
	expect(rich.isConnected).toBe(true);
});

test('rich-text typing is written, and stays undoable after the write lands', async () => {
	const { notes, target, text, settle } = await view();
	const rich = richOf(target);
	await typeRich(rich, ' Typed');
	expect(notes.noteBody(PATH).row?.body).toBe('Body. Typed\n');
	await settle();
	expect(text(PATH)).toContain('Body. Typed\n');
	// A write never changes what is on screen: the same view and its history stay.
	expect(richOf(target)).toBe(rich);
	expect(undoButton(target).disabled).toBe(false);
	while (!undoButton(target).disabled) {
		undoButton(target).dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);
		flushSync();
	}
	expect(notes.noteBody(PATH).row?.body).toBe('Body.\n');
	expect(rich.textContent).toBe('Body.');
	await settle();
	expect(text(PATH)).toContain('Body.\n');
});

test('different Source text replaces the rich-text document, and typing goes on there', async () => {
	const { notes, target } = await view();
	const rich = richOf(target);
	await typeRich(rich, ' Typed');
	click(target, 'Source');
	flushSync();
	type(
		only<HTMLTextAreaElement>(target, 'textarea[aria-label="Markdown source"]'),
		'Different\n',
	);
	await tick();
	expect(notes.noteBody(PATH).row?.body).toBe('Different\n');
	click(target, 'Rich text');
	flushSync();
	expect(rich.textContent).toBe('Different');
	expect(undoButton(target).disabled).toBe(true);
	await typeRich(rich, ' again');
	expect(notes.noteBody(PATH).row?.body).toBe('Different again\n');
});

test('a write that meets a change made elsewhere merges with it: the edit wins where both changed', async () => {
	const { target, put, text, failures, settle } = await view();
	put(PATH, noteText({ title: 'Theirs', body: 'Their body.\n' }));
	type(titleOf(target), 'Mine');
	await tick();
	await settle();
	expect(failures).toEqual([]);
	expect(text(PATH)).toContain('title: Mine');
	expect(text(PATH)).toContain('Their body.\n');
	expect(titleOf(target).value).toBe('Mine');
});

test('returning to the window shows a change made elsewhere', async () => {
	const { target, put, settle } = await view();
	const rich = richOf(target);
	put(PATH, noteText({ title: 'Theirs', body: 'Their body.\n' }));
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	await until(() => {
		flushSync();
		return titleOf(target).value === 'Theirs';
	}, 'the reread');
	await settle();
	expect(rich.textContent).toBe('Their body.');
});

test('once the notes are closing, the controls take no input', async () => {
	const { notes, target } = await view();
	const rich = richOf(target);
	const closed = notes.close();
	flushSync();
	expect(titleOf(target).disabled).toBe(true);
	expect(rich.getAttribute('contenteditable')).toBe('false');
	type(titleOf(target), 'Typed while closing');
	await tick();
	expect(notes.noteBody(PATH).row?.fields.title).toBe('Alpha');
	// The editor stays mounted while the last writes land.
	expect(richOf(target)).toBe(rich);
	await closed;
});
