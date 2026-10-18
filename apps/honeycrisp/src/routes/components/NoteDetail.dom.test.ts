/**
 * Note View Tests
 *
 * Mounts the real note view, `NoteDetail`, with its save bar, rich-text
 * editor, and UI library, over the real notes state and a real row session
 * on the in-memory OPFS stand-in. Events are delivered to the DOM the view
 * renders; jsdom has no layout, focus, selection, or IME, so these show what
 * a delivered event does, not that a person can type there.
 *
 * Key behaviors:
 * - Typing a title saves it, and switching between rich text and Source or
 *   typing a title keeps the one rich-text view
 * - Rich-text typing reaches the draft through ProseMirror's own DOM reading,
 *   saves, and stays undoable after the save lands
 * - Different Source text replaces the rich-text document
 * - A change made elsewhere asks Reload theirs or Keep mine; Reload theirs
 *   remounts the rich-text view on their text, Keep mine saves the draft
 * - A note deleted elsewhere asks Discard or Keep mine
 */
import '../../lib/dom.test-support.ts';
import { afterEach, expect, test } from 'bun:test';
import { buttonNamed, click, type } from '../../lib/dom.test-support.ts';
import {
	noteText,
	openNotesFolder,
	until,
} from '../../lib/folder.test-support.js';

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

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

/** Note `a` open in the notes state, and its view mounted as the page renders it. */
async function view() {
	const fixture = await openNotesFolder();
	const notes = createNotes(fixture.host);
	cleanup.push(() => notes.close());
	await fixture.write('notes/a.md', noteText({ title: 'Alpha' }));
	await notes.check();
	await notes.open('notes/a.md');
	const item = notes.opened;
	if (item?.kind !== 'note')
		throw new Error('notes/a.md did not open as a note');
	const session = item.session;
	const target = document.createElement('div');
	document.body.append(target);
	const host = mount(Host, {
		target,
		props: { component: NoteDetail as never, props: { notes, session } },
	});
	flushSync();
	cleanup.push(() => {
		unmount(host);
		flushSync();
		target.remove();
	});
	return { ...fixture, notes, session, target };
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

test('typing a title saves it, and switching tabs or typing keeps the one rich-text view', async () => {
	const { session, target, text } = await view();
	const rich = richOf(target);
	click(target, 'Source');
	flushSync();
	click(target, 'Rich text');
	flushSync();
	expect(richOf(target)).toBe(rich);
	type(titleOf(target), 'Retitled');
	await tick();
	expect(session.draft.fields.title).toBe('Retitled');
	expect((await session.settled()).status).toBe('saved');
	flushSync();
	expect(text('notes/a.md')).toContain('title: Retitled');
	expect(richOf(target)).toBe(rich);
	expect(rich.isConnected).toBe(true);
});

test('rich-text typing saves, and stays undoable after the save lands', async () => {
	const { session, target, text } = await view();
	const rich = richOf(target);
	await typeRich(rich, ' Typed');
	expect(session.draft.body).toBe('Body. Typed\n');
	expect((await session.settled()).status).toBe('saved');
	flushSync();
	expect(text('notes/a.md')).toContain('Body. Typed\n');
	// A save never assigns the draft: the same view and its history stay.
	expect(richOf(target)).toBe(rich);
	expect(undoButton(target).disabled).toBe(false);
	while (!undoButton(target).disabled) {
		undoButton(target).dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);
		flushSync();
	}
	expect(session.draft.body).toBe('Body.\n');
	expect(rich.textContent).toBe('Body.');
});

test('different Source text replaces the rich-text document, and typing goes on there', async () => {
	const { session, target } = await view();
	const rich = richOf(target);
	await typeRich(rich, ' Typed');
	click(target, 'Source');
	flushSync();
	type(
		only<HTMLTextAreaElement>(target, 'textarea[aria-label="Markdown source"]'),
		'Different\n',
	);
	await tick();
	expect(session.draft.body).toBe('Different\n');
	click(target, 'Rich text');
	flushSync();
	expect(rich.textContent).toBe('Different');
	expect(undoButton(target).disabled).toBe(true);
	await typeRich(rich, ' again');
	expect(session.draft.body).toBe('Different again\n');
});

test('a change made elsewhere asks first; Reload theirs remounts the rich-text view on their text', async () => {
	const { session, target, put } = await view();
	const rich = richOf(target);
	put('notes/a.md', noteText({ title: 'Theirs', body: 'Their body.\n' }));
	type(titleOf(target), 'Mine');
	await session.settled();
	await tick();
	expect(target.textContent).toContain('This changed elsewhere');
	expect(buttonNamed(target, 'Keep mine')).toBeDefined();
	click(target, 'Reload theirs');
	await until(() => session.draft.fields.title === 'Theirs', 'the reload');
	await tick();
	expect(titleOf(target).value).toBe('Theirs');
	expect(richOf(target)).not.toBe(rich);
	expect(richOf(target).textContent).toBe('Their body.');
	expect(target.textContent).not.toContain('This changed elsewhere');
});

test('Keep mine saves the draft over a change made elsewhere', async () => {
	const { session, target, put, text } = await view();
	put('notes/a.md', noteText({ title: 'Theirs' }));
	type(titleOf(target), 'Mine');
	await session.settled();
	await tick();
	click(target, 'Keep mine');
	await until(
		() => text('notes/a.md')?.includes('title: Mine') === true,
		'Keep mine',
	);
	await session.settled();
	await tick();
	expect(titleOf(target).value).toBe('Mine');
	expect(target.textContent).toContain('Saved to');
});

test('a note deleted elsewhere asks Discard or Keep mine', async () => {
	const { session, target, drop, text } = await view();
	drop('notes/a.md');
	type(titleOf(target), 'Kept');
	await session.settled();
	await tick();
	expect(target.textContent).toContain('This was deleted elsewhere');
	expect(buttonNamed(target, 'Discard')).toBeDefined();
	click(target, 'Keep mine');
	await until(
		() => text('notes/a.md')?.includes('title: Kept') === true,
		'the file to be created again',
	);
});
