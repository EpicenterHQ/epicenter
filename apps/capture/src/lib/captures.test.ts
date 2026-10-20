/**
 * Capture Store Tests
 *
 * Drives the real Capture store and its query cache over a real local
 * folder (`openFolder({ tables: captureTables })`) on an in-memory
 * IndexedDB, built as `<FolderApp>` builds it. A second handle of the
 * same profile stands in for another tab.
 *
 * Key behaviors:
 * - Creating a capture saves its text and an empty Thoughts section, and
 *   opens it; blank text is refused and stays in the form
 * - The timeline orders by the captured instant, and names files that are
 *   not captures for repair as text
 * - An edit is typed through the row's edit handle over the cache, saved
 *   after a pause, keeping frontmatter Capture does not declare
 * - Another tab's change is shown without replacing an edit not saved yet,
 *   and the save merges with it
 * - A failed save keeps the edit and its reason; saving again lands it
 * - A thought command saves at once; one on a list that changed is refused
 * - A thought typed and not added stays with its capture
 * - Edit as text saves the exact text, merges with another tab's change, and
 *   repairs a file that then opens as a capture
 * - Deleting runs after the edit's saves and removes the file
 * - Close sends the edits held and refuses new input
 */
import 'fake-indexeddb/auto';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type CapturesHarness,
	openCaptures,
	until,
} from './local-folder.test-support.js';

const { timelineOf } = await import('./captures.svelte.ts');

const harnesses: CapturesHarness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close();
});

async function open(files: Record<string, string> = {}) {
	const harness = await openCaptures(files);
	harnesses.push(harness);
	return harness;
}

const AT = '2026-10-01T10:30:00+08:00';
const PATH = 'captures/one.md';
/** A capture file written by hand, with metadata Capture does not declare. */
const HAND = `---\ncapturedAt: ${AT}\ncustom: kept\n---\n\nText\n\n## Thoughts\n\n- first\n  nested line\n`;
/** HAND with its body replaced. */
const withBody = (body: string) =>
	`---\ncapturedAt: ${AT}\ncustom: kept\n---\n\n${body}`;

/** `text` as the bytes a view of the file names as its source. */
const bytes = (text: string) => new TextEncoder().encode(text);

const { createRowEdit } = await import('@epicenter/svelte/edits');

/**
 * A view of capture `one` over the cache's row, and the form's commands in
 * it. It shows each change as it lands, so a command names the row shown now.
 */
function viewOfOne({ captures, folder, cached }: CapturesHarness) {
	const view = createRowEdit(folder.tables.captures.edit('one'), () => {
		const row = cached('one');
		return row?.issues === null ? row : undefined;
	});
	return { view, form: captures.formOf('one').in(view) };
}

function formOfOne(harness: CapturesHarness) {
	return viewOfOne(harness).form;
}

test('creating saves the text with an empty Thoughts section and opens it', async () => {
	const harness = await open();
	const { captures } = harness;
	captures.inputNewCapture('Hello\nworld');
	const { stem } = expectOk(await captures.create('Hello\nworld'));

	expect(stem).toMatch(/^\d{8}-\d{6}-[0-9a-z]{5}$/);
	expect(captures.opened).toEqual({ stem, mode: 'capture' });
	expect(captures.newCapture).toBe('');
	const text = await harness.text(`captures/${stem}.md`);
	expect(text).toMatch(
		/^---\ncapturedAt: "?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"?\n---\n\nHello\nworld\n\n## Thoughts\n$/,
	);
	expect(harness.cached(stem)?.issues).toBeNull();
});

test('blank text is refused and stays in the form', async () => {
	const { captures } = await open();
	captures.inputNewCapture('   ');
	const refusal = expectErr(await captures.create('   '));
	expect(refusal.message).toBe('Write something first.');
	expect(captures.newCapture).toBe('   ');
	expect(captures.opened).toBeUndefined();
});

test('the timeline orders by instant and names files to repair', async () => {
	const harness = await open({
		// 02:30Z, written with an offset: newer than 01:00Z although its text sorts first.
		'captures/a.md': `---\ncapturedAt: 2026-10-01T10:30:00+08:00\n---\n\nLater\n`,
		'captures/b.md': `---\ncapturedAt: 2026-10-01T01:00:00Z\n---\n\nEarlier\n\n## Thoughts\n\n- one\n- two\n`,
		'captures/bad-date.md': '---\ncapturedAt: yesterday\n---\n\nText\n',
		'captures/two-headings.md': `---\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- a\n\n## Thoughts\n\n- b\n`,
		'notes/elsewhere.md': `---\ncapturedAt: ${AT}\n---\n\nNot in the table\n`,
	});
	const { rows, repairs, unreadable } = timelineOf(harness.rows());

	expect(
		rows.map(({ stem, preview, thoughtCount }) => ({
			stem,
			preview,
			thoughtCount,
		})),
	).toEqual([
		{ stem: 'a', preview: 'Later', thoughtCount: 0 },
		{ stem: 'b', preview: 'Earlier', thoughtCount: 2 },
	]);
	expect(repairs.map(({ path }) => path)).toEqual([
		'captures/bad-date.md',
		'captures/two-headings.md',
	]);
	expect(repairs[0]?.problem).toContain('capturedAt');
	expect(unreadable).toEqual([]);
});

test('an edit saves after a pause and keeps undeclared frontmatter', async () => {
	const harness = await open({ [PATH]: HAND });
	const form = formOfOne(harness);
	form.inputText('Edited');
	// The row's body starts after the frontmatter, at its blank separator line.
	expect(form.body).toBe('\nEdited\n\n## Thoughts\n\n- first\n  nested line\n');
	expect(harness.context.getStatus().saving || harness.context.getStatus().unsaved.length > 0).toBe(true);

	await harness.quiet();
	expect(form.body).toBeUndefined();
	expect(await harness.text(PATH)).toBe(
		withBody('Edited\n\n## Thoughts\n\n- first\n  nested line\n'),
	);
	expect(harness.context.getStatus().saving || harness.context.getStatus().unsaved.length > 0).toBe(false);
});

test("another tab's change shows without replacing typing, and the save merges with it", async () => {
	const harness = await openCaptures({ [PATH]: HAND }, { saveAfterMs: 60_000 });
	harnesses.push(harness);
	const form = formOfOne(harness);
	form.inputText('Typed here');

	// Another tab adds a key while the typing waits for its pause.
	await harness.writeElsewhere(
		PATH,
		HAND.replace('custom: kept', 'custom: kept\nmood: calm'),
	);
	await until(
		() => harness.cached('one')?.text.includes('mood: calm') ?? false,
		'the other tab’s change',
	);
	// The cache shows it; the form still shows the text typed here.
	expect(form.body).toContain('Typed here');

	await form.flush();
	await harness.quiet();
	const saved = await harness.text(PATH);
	expect(saved).toContain('mood: calm');
	expect(saved).toContain(
		'Typed here\n\n## Thoughts\n\n- first\n  nested line\n',
	);
	expect(form.body).toBeUndefined();
});

test('a failed save keeps the edit and its reason; saving again lands it', async () => {
	const harness = await open({ [PATH]: HAND });
	const form = formOfOne(harness);
	const restore = harness.failSaves();
	form.inputNewThought('kept');
	form.addThought();
	await until(() => form.error !== undefined && !form.saving, 'the failure');

	expect(form.body).toContain('- kept');
	expect(harness.captures.saveLabel).toBe('Not saved');
	expect(harness.captures.failures).toEqual([
		{
			stem: 'one',
			path: PATH,
			reason: expect.stringMatching(
				/^This device's storage refused it: .*the disk is full/,
			),
		},
	]);
	restore();
	expect(await harness.text(PATH)).toBe(HAND);

	await harness.folder.tables.captures.edit('one').retry();
	await harness.quiet();
	expect(form.body).toBeUndefined();
	expect(await harness.text(PATH)).toContain('- kept\n');
	expect(harness.captures.saveLabel).toBe('Saved');
});

test('thought commands save at once; one on a changed list is refused', async () => {
	const harness = await open({
		[PATH]: withBody('Text\n\n## Thoughts\n\n- a\n- b\n- c\n'),
	});
	const form = formOfOne(harness);
	expect(form.swapThoughts(0, 1, ['a', 'b', 'c'])).toBe(true);
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(
		withBody('Text\n\n## Thoughts\n\n- b\n- a\n- c\n'),
	);

	// The view still shows the list from before the move.
	expect(form.deleteThought(0, ['a', 'b', 'c'])).toBe(false);
	expect(form.refusal).toBe(
		'The thoughts changed since they were shown, so nothing was changed.',
	);

	form.startEditing(2, ['b', 'a', 'c']);
	const edit = form.editing;
	if (edit === undefined) throw new Error('No thought edit started');
	form.inputEditing('C', edit.id);
	expect(form.commitEditing(edit.id)).toBe(true);
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(
		withBody('Text\n\n## Thoughts\n\n- b\n- a\n- C\n'),
	);
});

test('two views of one capture each type over what they show, and share the thought typed', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, folder } = harness;
	const older = harness.cached('one');
	if (older?.issues !== null || older === undefined)
		throw new Error('one is not cached as a capture');
	await harness.writeElsewhere(
		PATH,
		HAND.replace('Text', 'Text changed elsewhere'),
	);
	await until(
		() => harness.cached('one')?.body.includes('elsewhere') === true,
		'the other tab',
	);
	const newer = harness.cached('one');
	if (newer?.issues !== null || newer === undefined)
		throw new Error('one is not cached as a capture');
	const edit = folder.tables.captures.edit('one');
	// Two views, each over the row it read; neither knows of the other.
	const oldView = createRowEdit(edit, () => older);
	const newView = createRowEdit(edit, () => newer);
	expect(oldView.row.body).toContain('\nText\n');
	expect(newView.row.body).toContain('Text changed elsewhere');
	const form = captures.formOf('one');
	const inOld = form.in(oldView);
	const inNew = form.in(newView);

	// The thought typed is the form's, whichever view shows it.
	inOld.inputNewThought('shared');
	expect(inNew.newThought).toBe('shared');
	// The newer view adds it over what it shows; the older view is gone.
	expect(inNew.addThought()).toBe(true);
	await harness.quiet();
	const saved = (await harness.text(PATH)) ?? '';
	expect(saved).toContain('Text changed elsewhere');
	expect(saved).toContain('- shared\n');
	expect(inOld.newThought).toBe('');

	// Text typed in the older view is over the text it showed, merged.
	inOld.inputText('Text, typed in the old view');
	await inOld.flush();
	await harness.quiet();
	expect(await harness.text(PATH)).toContain('Text, typed in the old view');
	expect(await harness.text(PATH)).toContain('- shared\n');
});

/** Capture `one` with thoughts `a` and `b`, and two views that each showed it once. */
async function twoViewsOfThoughts() {
	const harness = await openCaptures(
		{ [PATH]: withBody('Text\n\n## Thoughts\n\n- a\n- b\n') },
		{ saveAfterMs: 60_000 },
	);
	harnesses.push(harness);
	const stored = harness.cached('one');
	if (stored?.issues !== null || stored === undefined)
		throw new Error('one is not cached as a capture');
	const edit = harness.folder.tables.captures.edit('one');
	const a = createRowEdit(edit, () => stored);
	const b = createRowEdit(edit, () => stored);
	expect(a.row.body).toBe(b.row.body);
	const form = harness.captures.formOf('one');
	return { harness, form, inA: form.in(a), inB: form.in(b) };
}

test('a thought edit is refused, with its text kept, when another view deleted its thought', async () => {
	const { harness, form, inA, inB } = await twoViewsOfThoughts();
	inA.startEditing(0, ['a', 'b']);
	const edit = form.editing;
	if (edit === undefined) throw new Error('No thought edit started');
	inA.inputEditing('my edited first', edit.id);

	expect(inB.deleteThought(0, ['a', 'b'])).toBe(true);
	await form.flush();
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(
		withBody('Text\n\n## Thoughts\n\n- b\n'),
	);

	// A still shows `a` first, but it is gone now: nothing is written.
	expect(inA.commitEditing(edit.id)).toBe(false);
	expect(form.refusal).toContain('Your edit is kept here');
	expect(form.editing).toMatchObject({
		text: 'my edited first',
		original: 'a',
	});
	expect(form.body).toBeUndefined();
	expect(await harness.text(PATH)).toBe(
		withBody('Text\n\n## Thoughts\n\n- b\n'),
	);
});

test('a command on a list another view changed is refused, though this view still shows it', async () => {
	const { harness, form, inA, inB } = await twoViewsOfThoughts();
	expect(inB.swapThoughts(0, 1, ['a', 'b'])).toBe(true);
	await form.flush();
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(
		withBody('Text\n\n## Thoughts\n\n- b\n- a\n'),
	);

	expect(inA.deleteThought(0, ['a', 'b'])).toBe(false);
	expect(form.refusal).toBe(
		'The thoughts changed since they were shown, so nothing was changed.',
	);
	expect(inA.swapThoughts(0, 1, ['a', 'b'])).toBe(false);
	inA.startEditing(0, ['a', 'b']);
	expect(form.editing).toBeUndefined();
	expect(form.body).toBeUndefined();
	expect(await harness.text(PATH)).toBe(
		withBody('Text\n\n## Thoughts\n\n- b\n- a\n'),
	);
});

test('a thought typed and not added stays with its capture', async () => {
	const harness = await open({
		[PATH]: HAND,
		'captures/two.md': `---\ncapturedAt: ${AT}\n---\n\nOther\n`,
	});
	const { captures } = harness;
	await captures.open('one', 'capture');
	formOfOne(harness).inputNewThought('not yet');
	await captures.open('two', 'capture');
	captures.leave();

	expect(captures.formOf('one').newThought).toBe('not yet');
	expect(captures.formOf('two').newThought).toBe('');
	expect(harness.context.getStatus().saving || harness.context.getStatus().unsaved.length > 0).toBe(false);
	expect(await harness.text(PATH)).toBe(HAND);
});

test('Edit as text saves the exact text and merges with another tab', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'text');
	const edit = harness.folder.files.edit(PATH);
	const typed = HAND.replace('Text', 'Typed as text');
	expectOk(edit.change(bytes(HAND), typed));
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(typed);

	// Another tab changes the frontmatter while more is typed below.
	const again = typed.replace('nested line', 'nested line, again');
	edit.change(bytes(typed), again);
	await harness.writeElsewhere(
		PATH,
		typed.replace('custom: kept', 'custom: changed'),
	);
	await edit.save();
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(
		again.replace('custom: kept', 'custom: changed'),
	);
});

test('a file repaired as text opens as a capture', async () => {
	const broken = '---\ncapturedAt: yesterday\n---\n\nText\n';
	const harness = await open({ [PATH]: broken });
	const { captures } = harness;

	// Not a capture: the capture view sends it to text.
	await captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'text' });

	const fixed = broken.replace('yesterday', AT);
	harness.folder.files.edit(PATH).change(bytes(broken), fixed);
	await captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'capture' });
	expect(await harness.text(PATH)).toBe(fixed);
});

test('a failed text save keeps the typing until saved again', async () => {
	const harness = await open({ [PATH]: HAND });
	const edit = harness.folder.files.edit(PATH);
	const restore = harness.failSaves();
	edit.change(bytes(HAND), `${HAND}more\n`);
	await edit.save();

	expect(edit.pending?.error?.name).toBe('StorageFailed');
	expect(edit.pending).toMatchObject({ text: `${HAND}more\n` });
	expect(harness.captures.saveLabel).toBe('Not saved');

	restore();
	await edit.retry();
	await harness.quiet();
	expect(edit.pending).toBeUndefined();
	expect(await harness.text(PATH)).toBe(`${HAND}more\n`);
});

test('closing after a failed whole-file save returns its exact text for recovery', async () => {
	const harness = await open({ [PATH]: HAND });
	const changed = HAND.replace('Text', 'Text kept after close');
	const restore = harness.failSaves();
	harness.folder.files.edit(PATH).change(bytes(HAND), changed);
	const unsaved = await harness.context.close();
	restore();
	expect(unsaved).toMatchObject([
		{ path: PATH, unsaved: changed, error: { name: 'StorageFailed' } },
	]);
	expect(await harness.text(PATH)).toBe(HAND);
});

test('deleting waits for the edit and removes the file', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const form = formOfOne(harness);
	form.inputText('Last words');

	const deletion = captures.deletionFor('one');
	expect(deletion.title).toBe('Last words');
	const deleted = expectOk(await captures.delete(deletion));
	expect(deleted.deleted).toBe(true);

	await harness.quiet();
	expect(await harness.text(PATH)).toBeUndefined();
	expect(captures.opened).toBeUndefined();
	expect(harness.cached('one')).toBeUndefined();
});

test('a delete sends text typed as text first', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	harness.folder.files.edit(PATH).change(bytes(HAND), `${HAND}typed\n`);
	expectOk(await captures.delete(captures.deletionFor('one')));
	await harness.quiet();
	expect(harness.folder.files.edit(PATH).pending).toBeUndefined();
	expect(await harness.text(PATH)).toBeUndefined();
});

test('close sends the edit held and refuses new input', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, context } = harness;
	const form = formOfOne(harness);
	form.inputText('Sent at close');

	const unsaved = await context.close();
	expect(unsaved).toEqual([]);
	expect(await harness.text(PATH)).toBe(
		withBody('Sent at close\n\n## Thoughts\n\n- first\n  nested line\n'),
	);

	expect(captures.fenced).toBe(true);
	form.inputText('Too late');
	expect(form.body).toBeUndefined();
	expect(
		expectErr(harness.folder.files.edit(PATH).change(bytes(HAND), 'x')).name,
	).toBe('Locked');
	captures.inputNewCapture('Too late');
	expect(captures.newCapture).toBe('');
	expect(expectErr(await captures.create('Too late')).name).toBe('NotStarted');
});

test('switching from failed text to a capture waits for explicit retry', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, folder } = harness;
	await captures.open('one', 'text');
	const edit = folder.files.edit(PATH);
	const changed = `${HAND}more\n`;
	edit.change(bytes(HAND), changed);
	const restore = harness.failSaves();
	await edit.save();
	restore();
	await captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'text' });
	expect(edit.pending?.error?.name).toBe('StorageFailed');
	expect(await harness.text(PATH)).toBe(HAND);
	await edit.retry();
	await captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'capture' });
	expect(await harness.text(PATH)).toBe(changed);
});
