/**
 * Capture Store Tests
 *
 * Drives the real Capture store and its query cache over a real local
 * folder (`openFolder({ tables: captureTables })`) on an in-memory
 * IndexedDB, built as `<FolderApp>` builds it. A second handle of the
 * same profile stands in for another tab.
 *
 * Key behaviors:
 * - Add writes one finished capture, its first write; blank text and a
 *   failed write leave no file
 * - The timeline orders by the captured instant, and names files that are
 *   not captures for repair as text
 * - An edit is typed through the row's edit handle over the cache, saved
 *   after a pause, keeping frontmatter Capture does not declare
 * - Another tab's change preserves local input; the next whole-file publication wins
 * - A failed save keeps the edit and its reason; saving again lands it
 * - A thought command saves at once; one on a list that changed is refused
 * - A thought opens as text at its own lines, unless its list changed
 * - Edit as text saves exact text, including unfinished Markdown, and can
 *   reopen as a capture without saving or refreshing
 * - Deleting runs after the edit's saves and removes the file
 * - Close leaves held edits unsaved and refuses new input
 */
import 'fake-indexeddb/auto';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { composeBody } from '@epicenter/capture';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type CapturesHarness,
	openCaptures,
	until,
} from './local-folder.test-support.js';

const { timelineOf } = await import('./captures.svelte.ts');
const { createCaptureActions } = await import('./capture-actions.svelte.ts');
const { createFileEdit } = await import('@epicenter/svelte/edits');

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

/** Capture commands over the Folder edit, as the view constructs them. */
function actionsOf({ folder }: CapturesHarness, stem = 'one') {
	return createCaptureActions(
		createFileEdit(folder.tables.captures.edit(stem)),
	);
}

/** The folder's edit of capture `one` as its exact text, read. */
async function textOfOne({ folder }: CapturesHarness) {
	const edit = folder.files.edit(PATH);
	expectOk(await edit.refresh());
	return edit;
}

test('Add writes one finished capture and opens it at Add a thought', async () => {
	const harness = await open();
	const { captures, folder } = harness;
	const { stem } = expectOk(await captures.create('Hello\nworld'));
	expect(stem).toMatch(/^\d{8}-\d{6}-[0-9a-z]{5}$/);
	expect(captures.opened).toEqual({
		stem,
		mode: 'capture',
		focus: 'new-thought',
	});
	const row = expectOk(await folder.tables.captures.get(stem));
	expect(row?.fields).toEqual({ capturedAt: expect.any(String) });
	expect(row?.body).toBe('\nHello\nworld\n\n## Thoughts\n');
	expect(harness.rows()).toHaveLength(1);
	expect(timelineOf(harness.rows()).drafts).toEqual([]);
});

test('Add keeps pasted Markdown as composeBody writes it, and an ambiguous result opens as text', async () => {
	const harness = await open();
	const pasted = 'Pasted article\n\n## Thoughts\n\n- belongs to the article';
	const { stem } = expectOk(await harness.captures.create(pasted));
	const row = expectOk(await harness.folder.tables.captures.get(stem));
	expect(row?.body).toBe(composeBody(pasted).body);
	expect(harness.captures.opened).toEqual({ stem, mode: 'text' });
});

test('blank text is refused by Add, and nothing is written', async () => {
	const harness = await open();
	const refusal = expectErr(await harness.captures.create(' \n\t'));
	expect(refusal).toMatchObject({
		name: 'Refused',
		message: 'Write something first.',
	});
	expect(harness.captures.opened).toBeUndefined();
	expect(expectOk(await harness.folder.tables.captures.list())).toEqual([]);
});

test('a failed Add writes nothing and opens nothing', async () => {
	const harness = await open();
	const restore = harness.failSaves();
	expect(expectErr(await harness.captures.create('Kept')).name).toBe(
		'StorageFailed',
	);
	restore();
	expect(harness.captures.opened).toBeUndefined();
	expect(expectOk(await harness.folder.tables.captures.list())).toEqual([]);
});

test('close may fail an admitted Add before storage starts', async () => {
	const harness = await open();
	const creating = harness.captures.create('Before close');
	const closing = harness.context.close();
	expect(expectErr(await creating).name).toBe('StorageFailed');
	expect(closing).toBeUndefined();
});

test('close may fail an admitted Delete before storage starts', async () => {
	const harness = await open({ [PATH]: HAND });
	const deleting = harness.captures.delete(harness.captures.deletionFor('one'));
	const closing = harness.context.close();
	expect(expectErr(await deleting).name).toBe('StorageFailed');
	expect(closing).toBeUndefined();
	expect(await harness.text(PATH)).toBe(HAND);
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
	const actions = actionsOf(harness);
	const fileEdit = harness.folder.tables.captures.edit('one');
	actions.inputText('Edited');
	// The row's body starts after the frontmatter, at its blank separator line.
	expect(fileEdit.getSnapshot().content?.body).toBe(
		'\nEdited\n\n## Thoughts\n\n- first\n  nested line\n',
	);
	expect(
		harness.context.getStatus().saving ||
			harness.context.getStatus().unsaved.length > 0,
	).toBe(true);

	await harness.quiet();
	expect(fileEdit.getSnapshot().isDirty).toBe(false);
	expect(await harness.text(PATH)).toBe(
		withBody('Edited\n\n## Thoughts\n\n- first\n  nested line\n'),
	);
	expect(
		harness.context.getStatus().saving ||
			harness.context.getStatus().unsaved.length > 0,
	).toBe(false);
});

test("another tab's change preserves input until a complete source publication", async () => {
	const harness = await openCaptures({ [PATH]: HAND }, { saveAfterMs: 60_000 });
	harnesses.push(harness);
	const actions = actionsOf(harness);
	const fileEdit = harness.folder.tables.captures.edit('one');
	actions.inputText('Typed here');

	// Another tab adds a key while the typing waits for its pause.
	await harness.writeElsewhere(
		PATH,
		HAND.replace('custom: kept', 'custom: kept\nmood: calm'),
	);
	await until(
		() => harness.cached('one')?.text.includes('mood: calm') ?? false,
		'the other tab’s change',
	);
	// The cache has the outside change; the Folder still holds the input typed here.
	expect(fileEdit.getSnapshot().content?.body).toContain('Typed here');

	await fileEdit.save();
	expect(fileEdit.getSnapshot().saveError).toBeUndefined();
	expect(await harness.text(PATH)).not.toContain('mood: calm');
	const content = fileEdit.getSnapshot().content;
	if (content === undefined)
		throw new Error('The capture lost acquired content');
	expectOk(
		fileEdit.replaceText(
			content.text.replace('custom: kept', 'custom: kept\nmood: calm'),
		),
	);
	await fileEdit.save();
	await harness.quiet();
	const saved = await harness.text(PATH);
	expect(saved).toContain('mood: calm');
	expect(saved).toContain(
		'Typed here\n\n## Thoughts\n\n- first\n  nested line\n',
	);
	expect(fileEdit.getSnapshot().isDirty).toBe(false);
});

test('a failed save keeps the edit and its reason; saving again lands it', async () => {
	const harness = await open({ [PATH]: HAND });
	const actions = actionsOf(harness);
	const fileEdit = harness.folder.tables.captures.edit('one');
	const restore = harness.failSaves();
	expect(actions.addThought('kept')).toBe(true);
	await until(
		() =>
			fileEdit.getSnapshot().saveError !== undefined &&
			fileEdit.getSnapshot().isSaving === false,
		'the failure',
	);

	expect(fileEdit.getSnapshot().content?.body).toContain('- kept');
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

	await fileEdit.save();
	await harness.quiet();
	expect(fileEdit.getSnapshot().isDirty).toBe(false);
	expect(await harness.text(PATH)).toContain('- kept\n');
	expect(harness.captures.saveLabel).toBe('Saved');
});

test('thought commands save at once; one on a changed list is refused', async () => {
	const harness = await open({
		[PATH]: withBody('Text\n\n## Thoughts\n\n- a\n- b\n- c\n'),
	});
	const actions = actionsOf(harness);
	expect(actions.swapThoughts(0, 1, ['a', 'b', 'c'])).toBe(true);
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(
		withBody('Text\n\n## Thoughts\n\n- b\n- a\n- c\n'),
	);

	// The view still shows the list from before the move.
	expect(actions.deleteThought(0, ['a', 'b', 'c'])).toBe(false);
	expect(actions.refusal).toBe(
		'The thoughts changed since they were shown, so nothing was changed.',
	);

	expect(actions.deleteThought(2, ['b', 'a', 'c'])).toBe(true);
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(
		withBody('Text\n\n## Thoughts\n\n- b\n- a\n'),
	);
});

test('adding a thought uses the current Folder edit after another tab changes it', async () => {
	const harness = await open({ [PATH]: HAND });
	const actions = actionsOf(harness);
	const fileEdit = harness.folder.tables.captures.edit('one');
	// A view shows the capture, so another tab's change is read for it.
	const stop = fileEdit.subscribe(() => {});
	expectOk(await fileEdit.refresh());
	await harness.writeElsewhere(
		PATH,
		HAND.replace('Text', 'Text changed elsewhere'),
	);
	await until(
		() => fileEdit.getSnapshot().content?.body?.includes('elsewhere') === true,
		'the other tab',
	);
	// A thought adds over what the Folder edit shows now.
	expect(actions.addThought('shared')).toBe(true);
	expect(fileEdit.getSnapshot().content?.body).toContain('- shared');
	await harness.quiet();
	const saved = (await harness.text(PATH)) ?? '';
	expect(saved).toContain('Text changed elsewhere');
	expect(saved).toContain('- shared\n');
	stop();
});

test('a blank thought is refused and writes nothing', async () => {
	const harness = await open({ [PATH]: HAND });
	const actions = actionsOf(harness);
	const fileEdit = harness.folder.tables.captures.edit('one');
	expect(actions.addThought(' \n ')).toBe(false);
	expect(actions.refusal).toBe('Write something first.');
	expect(fileEdit.getSnapshot().isDirty).toBe(false);
	expect(harness.context.getStatus().unsaved).toEqual([]);
	expect(await harness.text(PATH)).toBe(HAND);
});

/** Capture `one` with thoughts `a` and `b`, shown. */
async function thoughtsShown(
	file = withBody('Text\n\n## Thoughts\n\n- a\n- b\n'),
) {
	const harness = await openCaptures({ [PATH]: file }, { saveAfterMs: 60_000 });
	harnesses.push(harness);
	const actions = actionsOf(harness);
	// A view shows it until the harness closes.
	const fileEdit = harness.folder.tables.captures.edit('one');
	fileEdit.subscribe(() => {});
	expectOk(await fileEdit.refresh());
	return { harness, actions };
}

/** Another tab replaces the thoughts of capture `one`, and this page reads it. */
async function thoughtsElsewhere(harness: CapturesHarness, thoughts: string) {
	const fileEdit = harness.folder.tables.captures.edit('one');
	const changed = withBody(`Text\n\n## Thoughts\n\n${thoughts}`);
	await harness.writeElsewhere(PATH, changed);
	await until(
		() => fileEdit.getSnapshot().content?.text === changed,
		'the other tab',
	);
}

test('a command on a list another tab changed is refused, though a view still showed it', async () => {
	const { harness, actions } = await thoughtsShown();
	await thoughtsElsewhere(harness, '- b\n- a\n');

	expect(actions.deleteThought(0, ['a', 'b'])).toBe(false);
	expect(actions.refusal).toBe(
		'The thoughts changed since they were shown, so nothing was changed.',
	);
	expect(actions.swapThoughts(0, 1, ['a', 'b'])).toBe(false);
	expect(actions.locateThought(0, ['a', 'b'])).toBeUndefined();
	expect(harness.folder.tables.captures.edit('one').getSnapshot().isDirty).toBe(
		false,
	);
	expect(await harness.text(PATH)).toBe(
		withBody('Text\n\n## Thoughts\n\n- b\n- a\n'),
	);
});

test('a thought opens as text at its own lines, counted as a text box shows CRLF', async () => {
	const file = `---\r\ncapturedAt: ${AT}\r\n---\r\n\r\nText\r\n\r\n## Thoughts\r\n\r\n- a\r\n- b\r\n  more\r\n`;
	const { harness, actions } = await thoughtsShown(file);
	const range = actions.locateThought(1, ['a', 'b\nmore']);
	if (range === undefined) throw new Error('The thought was not found');
	const shown = file.replaceAll('\r\n', '\n');
	expect(shown.slice(range.start, range.end)).toBe('- b\n  more');
	expect(actions.refusal).toBeUndefined();

	harness.captures.open('one', 'text', range);
	expect(harness.captures.opened).toEqual({
		stem: 'one',
		mode: 'text',
		focus: range,
	});
	expect(await harness.text(PATH)).toBe(file);
});

test('Edit as text publishes exact current text over an outside change', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'text');
	const edit = await textOfOne(harness);
	const typed = HAND.replace('Text', 'Typed as text');
	expectOk(edit.replaceText(typed));
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(typed);

	// Another tab changes the frontmatter while more is typed below.
	const again = typed.replace('nested line', 'nested line, again');
	edit.replaceText(again);
	await harness.writeElsewhere(
		PATH,
		typed.replace('custom: kept', 'custom: changed'),
	);
	await edit.save();
	expect(edit.getSnapshot().saveError).toBeUndefined();
	expect(await harness.text(PATH)).toBe(again);
	expectOk(edit.replaceText(again.replace('custom: kept', 'custom: changed')));
	await edit.save();
	await harness.quiet();
	expect(await harness.text(PATH)).toBe(
		again.replace('custom: kept', 'custom: changed'),
	);
});

test('a file repaired as text opens as a capture before saving', async () => {
	const broken = '---\ncapturedAt: yesterday\n---\n\nText\n';
	const harness = await open({ [PATH]: broken });
	const { captures } = harness;

	// Not a capture: the capture view sends it to text.
	await captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'text' });

	const fixed = broken.replace('yesterday', AT);
	(await textOfOne(harness)).replaceText(fixed);
	await captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'capture' });
	expect(
		harness.folder.tables.captures.edit('one').getSnapshot().content?.text,
	).toBe(fixed);
	expect(await harness.text(PATH)).toBe(broken);
});

test('unfinished Markdown typed as text saves exactly; a failed save keeps it until saved again', async () => {
	const harness = await open({ [PATH]: HAND });
	const edit = await textOfOne(harness);
	// A thought being written as text: an open fence, no final line ending.
	const unfinished = `${HAND}- half a thought\n\n  \`\`\`ts\n  unclosed(`;
	const restore = harness.failSaves();
	edit.replaceText(unfinished);
	await edit.save();

	expect(edit.getSnapshot().saveError?.name).toBe('StorageFailed');
	expect(edit.getSnapshot().content?.text).toBe(unfinished);
	expect(harness.captures.saveLabel).toBe('Not saved');

	restore();
	await edit.save();
	await harness.quiet();
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(await harness.text(PATH)).toBe(unfinished);
});

test('a failed whole-file save retains exact text for recovery while open', async () => {
	const harness = await open({ [PATH]: HAND });
	const changed = HAND.replace('Text', 'Text kept after close');
	const restore = harness.failSaves();
	(await textOfOne(harness)).replaceText(changed);
	await harness.folder.files.edit(PATH).save();
	const unsaved = harness.context.getStatus().failures;
	restore();
	expect(unsaved).toMatchObject([
		{ path: PATH, error: { name: 'StorageFailed' } },
	]);
	expect(harness.folder.files.edit(PATH).getSnapshot().content?.text).toBe(
		changed,
	);
	expect(await harness.text(PATH)).toBe(HAND);
});

test('deleting removes the file without saving pending input first', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const actions = actionsOf(harness);
	actions.inputText('Last words');

	const deletion = captures.deletionFor('one');
	expect(deletion.title).toBe('Last words');
	expectOk(await captures.delete(deletion));

	await harness.quiet();
	expect(await harness.text(PATH)).toBeUndefined();
	expect(captures.opened).toBeUndefined();
	expect(harness.cached('one')).toBeUndefined();
});

test('a delete consumes captured pending source without publishing it', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	(await textOfOne(harness)).replaceText(`${HAND}typed\n`);
	expectOk(await captures.delete(captures.deletionFor('one')));
	await harness.quiet();
	expect(harness.folder.files.edit(PATH).getSnapshot().isDirty).toBe(false);
	expect(await harness.text(PATH)).toBeUndefined();
});

test('close leaves held input unsaved and refuses new input', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, context } = harness;
	const actions = actionsOf(harness);
	const fileEdit = harness.folder.tables.captures.edit('one');
	actions.inputText('Sent at close');

	expect(context.close()).toBeUndefined();
	expect(await harness.text(PATH)).toBe(HAND);

	expect(captures.fenced).toBe(true);
	actions.inputText('Too late');
	expect(fileEdit.getSnapshot().isDirty).toBe(true);
	expect(expectErr(harness.folder.files.edit(PATH).replaceText('x')).name).toBe(
		'Closing',
	);
	expect(actions.addThought('Too late')).toBe(false);
	expect(expectErr(await captures.create('Too late')).name).toBe('Closing');
});

test('switching from failed text to a capture keeps input and error until another save attempt', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'text');
	const edit = await textOfOne(harness);
	const changed = `${HAND}more\n`;
	edit.replaceText(changed);
	const restore = harness.failSaves();
	await edit.save();
	restore();
	await captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'capture' });
	expect(
		harness.folder.tables.captures.edit('one').getSnapshot().content?.text,
	).toBe(changed);
	expect(edit.getSnapshot().saveError?.name).toBe('StorageFailed');
	expect(await harness.text(PATH)).toBe(HAND);
	await edit.save();
	await captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'capture' });
	expect(await harness.text(PATH)).toBe(changed);
});
