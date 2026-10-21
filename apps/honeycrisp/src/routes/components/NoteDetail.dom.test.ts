/**
 * Note View Tests
 *
 * Mounts the real note view, `NoteDetail`, with its rich-text editor and UI
 * library, inside the query client the layout provides, over the real notes
 * state on this browser's local folder (an in-memory IndexedDB). Events are
 * delivered to the DOM the view renders; jsdom has no layout, focus,
 * selection, or IME, so these show what a delivered event does, not that a
 * person can type there.
 *
 * Key behaviors:
 * - A title typed is saved when the person leaves it, and switching between
 *   rich text and Source or typing a title keeps the one rich-text view
 * - Rich-text typing reaches the note's draft through ProseMirror's own DOM
 *   reading, saves after its pause, and stays undoable after the save lands
 * - Different Source text replaces the rich-text document
 * - A title typed before another tab saved keeps their body and wins the
 *   title
 * - A change another tab saved shows in the open note
 * - A save that fails says so and offers Save again, which saves it
 * - Once the notes are closing, the controls take no input, and the
 *   rich-text view stays mounted
 */
// Before the DOM: once a `window` exists, `fake-indexeddb/auto` installs
// IndexedDB on it rather than on the global the folder reads.
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	blur,
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

// jsdom has no layout, and its ranges cannot be measured. ProseMirror
// measures the cursor to scroll it into view after typing; it gets no boxes.
Range.prototype.getClientRects ??= () =>
	[] as unknown as ReturnType<Range['getClientRects']>;
Range.prototype.getBoundingClientRect ??= () =>
	({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

const { flushSync, mount, unmount } = await import('svelte');
const { openNotes, noteText, quiet, until } = await import(
	'../../lib/local.test-support.ts'
);
const { default: NoteDetail } = await import('./NoteDetail.svelte');
const { default: Host } = await import('../../lib/ui-host.test-support.svelte');

const PATH = 'notes/a.md';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

test('Edit as file keeps a note whose body changes failed to save', async () => {
	const { notes, target, failSaves } = await view({ saveAfterMs: 60_000 });
	const body = 'Keep this body\n';
	notes.noteBody(PATH).change({ body });
	failSaves();
	await notes.folder.files.edit(PATH).save();
	expect(notes.isUnsaved(PATH)).toBe(true);
	click(target, 'Edit as file');
	expect(notes.selected?.as).toBe('text');
	expect(notes.folder.files.edit(PATH).getText()).toContain(body);
	expect(notes.folder.files.edit(PATH).getPending()?.error).toBeDefined();
	expect(notes.noteBody(PATH).getMarkdown()?.body).toBe(body);
	failSaves(false);
	click(target, 'Save again');
	await until(() => !notes.isUnsaved(PATH), 'the explicit retry');
	click(target, 'Edit as file');
	await until(() => notes.selected?.as === 'text', 'the saved file opening');
});

test('a finishing Edit as file save does not reopen a note after selecting another', async () => {
	const { notes, target, write, folder } = await view({ saveAfterMs: 60_000 });
	await write('notes/b.md', noteText({ title: 'Beta' }));
	notes.noteBody(PATH).change({ body: 'A pending body\n' });
	click(target, 'Edit as file');
	notes.open('notes/b.md');
	await folder.tables.notes.edit('a').save();
	await quiet(notes);
	expect(notes.selected?.path).toBe('notes/b.md');
	expect(notes.selected?.as).toBe('note');
});

/**
 * Note `a` open in the notes state, and its view mounted as the page renders
 * it. Typing saves `saveAfterMs` after the last change.
 */
async function view({ saveAfterMs = 10 } = {}) {
	const fixture = await openNotes({ saveAfterMs });
	cleanup.push(() => fixture.close());
	await fixture.write(PATH, noteText({ title: 'Alpha' }));
	const { notes } = fixture;
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
	/** Let every save and the reads after them land, then render. */
	async function settle() {
		await quiet(notes);
		flushSync();
		await tick();
	}
	return { ...fixture, target, settle };
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
const statusOf = (target: ParentNode) =>
	only<HTMLElement>(target, '[data-testid="write-status"]').textContent ?? '';

test('typing a title saves it, and switching tabs or typing keeps the one rich-text view', async () => {
	const { target, text, settle } = await view();
	const rich = richOf(target);
	click(target, 'Source');
	flushSync();
	click(target, 'Rich text');
	flushSync();
	expect(richOf(target)).toBe(rich);
	type(titleOf(target), 'Retitled');
	blur(titleOf(target));
	await tick();
	await settle();
	expect(await text(PATH)).toContain('title: "Retitled"');
	expect(statusOf(target)).toMatch(/Saved to\s*notes\/a\.md/);
	expect(richOf(target)).toBe(rich);
	expect(rich.isConnected).toBe(true);
});

test('rich-text typing is saved after its pause, and stays undoable after the save lands', async () => {
	const { notes, target, text, settle } = await view();
	const rich = richOf(target);
	await typeRich(rich, ' Typed');
	expect(notes.noteBody(PATH).getMarkdown()?.body).toBe('Body. Typed\n');
	await settle();
	expect(await text(PATH)).toContain('Body. Typed\n');
	// A save never changes what is on screen: the same view and its history stay.
	expect(richOf(target)).toBe(rich);
	expect(undoButton(target).disabled).toBe(false);
	while (!undoButton(target).disabled) {
		undoButton(target).dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);
		flushSync();
	}
	expect(notes.noteBody(PATH).getMarkdown()?.body).toBe('Body.\n');
	expect(rich.textContent).toBe('Body.');
	await settle();
	expect(await text(PATH)).toContain('---\nBody.\n');
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
	expect(notes.noteBody(PATH).getMarkdown()?.body).toBe('Different\n');
	click(target, 'Rich text');
	flushSync();
	expect(rich.textContent).toBe('Different');
	expect(undoButton(target).disabled).toBe(true);
	await typeRich(rich, ' again');
	expect(notes.noteBody(PATH).getMarkdown()?.body).toBe('Different again\n');
});

test('a title typed before another tab saved keeps their body and wins the title', async () => {
	const { target, otherTab, text, local, settle } = await view({
		saveAfterMs: 60_000,
	});
	type(titleOf(target), 'Mine');
	await tick();
	const tab = await otherTab();
	const theirs = expectOk(await tab.tables.notes.get('a'));
	expectOk(
		await tab.tables.notes.set('a', theirs ?? null, {
			fields: { title: 'Theirs' },
			body: 'Their body.\n',
		}),
	);
	blur(titleOf(target));
	await tick();
	await settle();
	expect(local.getStatus().failures).toEqual([]);
	const saved = (await text(PATH)) ?? '';
	expect(saved).toContain('title: "Mine"');
	expect(saved).toContain('Their body.\n');
	expect(titleOf(target).value).toBe('Mine');
});

test('a change another tab saved shows in the open note', async () => {
	const { target, otherTab, settle } = await view();
	const rich = richOf(target);
	const tab = await otherTab();
	const theirs = expectOk(await tab.tables.notes.get('a'));
	expectOk(
		await tab.tables.notes.set('a', theirs ?? null, {
			fields: { title: 'Theirs' },
			body: 'Their body.\n',
		}),
	);
	await until(() => {
		flushSync();
		return titleOf(target).value === 'Theirs';
	}, 'the reported change to be read');
	await settle();
	expect(rich.textContent).toBe('Their body.');
});

test('a save that fails says so and offers Save again, which saves it', async () => {
	const { target, failSaves, text } = await view();
	failSaves();
	type(titleOf(target), 'Kept');
	blur(titleOf(target));
	await until(() => {
		flushSync();
		return statusOf(target).includes('Not saved');
	}, 'the failure');
	expect(statusOf(target)).toContain('QuotaExceededError');
	expect(titleOf(target).value).toBe('Kept');

	failSaves(false);
	click(target, 'Save again');
	await until(() => {
		flushSync();
		return /Saved to/.test(statusOf(target));
	}, 'the retry');
	expect(await text(PATH)).toContain('title: "Kept"');
});

test('once the notes are closing, the controls take no input', async () => {
	const { notes, local, target, text } = await view();
	const rich = richOf(target);
	const closed = local.close();
	flushSync();
	expect(titleOf(target).disabled).toBe(true);
	expect(rich.getAttribute('contenteditable')).toBe('false');
	type(titleOf(target), 'Typed while closing');
	flushSync();
	expect(notes.noteBody(PATH).getMarkdown()?.fields.title).toBe('Alpha');
	// The editor stays mounted while the last saves land.
	expect(richOf(target)).toBe(rich);
	await closed;
	expect(await text(PATH)).toContain('title: "Alpha"');
});
