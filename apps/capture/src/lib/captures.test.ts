/**
 * Capture Store Tests
 *
 * Drives the real Capture store and its TanStack Query cache against a real
 * browser folder over an in-memory OPFS stand-in. Views are stood in for as
 * they behave: the timeline observes the capture listing, and a capture
 * opened as text observes that file's text.
 *
 * Key behaviors:
 * - Creating a capture writes its text and an empty Thoughts section, and
 *   opens it; listing and opening write nothing
 * - The timeline orders by the captured instant, names files that are not
 *   captures for repair as text, and lists unreadable files apart
 * - An edit is a body draft over the cache, saved when the view sends it,
 *   keeping metadata Capture does not declare
 * - Saves run one at a time; text typed meanwhile goes in one more save,
 *   from the version the first wrote
 * - A change reported on the folder's channel reads the view again, and
 *   never replaces an edit not saved yet
 * - A save that meets a change made elsewhere merges with it, and the edit
 *   wins where both changed; a raw text write merges by line the same way,
 *   and one to a file deleted elsewhere drops the typed text and reports it
 * - A save that fails keeps the edit and reports it, and the next change
 *   sends it again; a save to a file deleted elsewhere drops the edit and
 *   reports its text; a change the body cannot hold is refused
 * - A file that is not a valid capture opens as text, is written as typed,
 *   and opens as a capture once repaired
 * - A thought typed and not added stays with its capture; a thought command
 *   on a list that changed meanwhile is refused and keeps its text
 * - Deleting runs after the edit's saves and removes what they saved; a
 *   file changed elsewhere since is not deleted
 * - Saves never commit; Save version records one
 * - Close fences input and waits for every mutation
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openCaptures } from './browser-folder.test-support.js';
import type { CaptureForm } from './capture-form.svelte.js';
import type { Captures } from './captures.svelte.js';
import {
	cached,
	cachedText,
	listing,
	observe,
	quiet,
} from './query.test-support.js';

const { timelineOf } = await import('./captures.svelte.ts');

type Opened = Awaited<ReturnType<typeof openCaptures>>;
const opened: Opened[] = [];
afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close();
});

async function open(files: Record<string, string> = {}) {
	const harness = await openCaptures(files);
	opened.push(harness);
	return harness;
}

const AT = '2026-10-01T10:30:00+08:00';
/** A capture file written by hand, with metadata Capture does not declare. */
const HAND = `---\ncapturedAt: ${AT}\ncustom: kept\n---\n\nText\n\n## Thoughts\n\n- first\n  nested line\n`;
/** HAND as a write saves it: plain YAML frontmatter, the body byte for byte. */
const FORMATTED = HAND.replace(`capturedAt: ${AT}`, `capturedAt: "${AT}"`);
const PATH = 'captures/one.md';

/** How many saves of a capture are running. */
const savesRunning = ({ captures }: Opened) =>
	captures.queryClient.isMutating({
		mutationKey: captures.folder$.captures.save.mutationOptions().mutationKey,
	});

/** Create a capture through the New capture form; it opens. Answers its stem. */
async function create(harness: Opened, text: string) {
	harness.captures.inputNewCapture(text);
	expectOk(await harness.captures.create(text));
	await quiet(harness.captures);
	const stem = harness.captures.opened?.stem;
	if (stem === undefined) throw new Error('the new capture did not open');
	return stem;
}

// ============================================================================
// Creating and listing
// ============================================================================

test('creating writes the text and an empty Thoughts section, opens it, and clears the form', async () => {
	const harness = await open();
	const { captures, counter } = harness;
	const stem = await create(harness, 'Exact\n  text ');
	const path = `captures/${stem}.md`;
	expect(captures.newCapture).toBe('');
	expect(captures.opened).toEqual({ stem, mode: 'capture' });
	expect(await harness.text(path)).toMatch(
		/^---\ncapturedAt: "[^"]+"\n---\n\nExact\n {2}text \n\n## Thoughts\n$/,
	);
	expect(timelineOf(listing(captures)).rows.map((row) => row.path)).toEqual([
		path,
	]);

	// Listing and opening again write nothing.
	const before = counter.mdWrites;
	captures.leave();
	await harness.reportChange(path);
	captures.open(stem, 'capture');
	captures.open(stem, 'text');
	const stop = observe(captures, path);
	await quiet(captures);
	stop();
	expect(counter.mdWrites).toBe(before);
});

test('blank New capture text is refused and stays in the form', async () => {
	const { captures } = await open();
	captures.inputNewCapture('   ');
	expect(expectErr(await captures.create('   '))).toMatchObject({
		name: 'NotStarted',
		reason: 'Write something first.',
	});
	expect(captures.newCapture).toBe('   ');
	expect(captures.unsettled).toBe(true);
});

test('the timeline orders by the instant across offsets, names files to repair, and lists unreadable ones apart', async () => {
	const harness = await open({
		'captures/utc.md': '---\ncapturedAt: 2026-10-01T03:00:00Z\n---\n\nUTC\n',
		'captures/east.md': `---\ncapturedAt: ${AT}\n---\n\nEast\n`,
		'captures/nodate.md': '---\ncapturedAt: nope\n---\n\nNo date\n',
		'captures/two-headings.md':
			'---\ncapturedAt: 2026-10-01T03:00:00Z\n---\n\n## Thoughts\n\n## Thoughts\n',
	});
	await harness.folder.files.create(
		'captures/binary.md',
		new Uint8Array([0xff, 0xfe]),
	);
	await harness.reportChange('captures/binary.md');
	const { rows, repairs, unreadable } = timelineOf(listing(harness.captures));
	// 10:30+08:00 is 02:30Z, before 03:00Z.
	expect(rows.map((row) => row.preview)).toEqual(['UTC', 'East']);
	expect(repairs.map((row) => row.path)).toEqual([
		'captures/nodate.md',
		'captures/two-headings.md',
	]);
	expect(repairs[0]?.problem).toContain('capturedAt');
	expect(repairs[1]?.problem).toContain('Thoughts');
	expect(unreadable).toEqual([
		{ path: 'captures/binary.md', message: 'It is not UTF-8 text.' },
	]);
});

/** What the capture view does with typed text once the person pauses: put it in the form, then save. */
function typeText(form: CaptureForm, text: string) {
	form.inputText(text);
	void form.flush();
}

/** What the text view does with typed text once the person pauses. */
function typeFile(captures: Captures, path: string, text: string) {
	const taken = captures.editText(path, text);
	void captures.saveText(path);
	return taken;
}

// ============================================================================
// Edits and writes
// ============================================================================

test('an edit is shown at once and saved to the file, keeping metadata Capture does not declare', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	captures.open('one', 'capture');
	const form = captures.formOf('one');
	form.inputNewThought('second');
	expect(form.addThought()).toBe(true);
	typeText(form, 'Edited');
	expect(form.body).toContain('\nEdited\n');
	await quiet(captures);
	expect(await harness.text(PATH)).toBe(
		`${FORMATTED.replace('\nText\n', '\nEdited\n')}- second\n`,
	);
	// The saves landed: the edit is done, and the cache holds what they wrote.
	expect(form.body).toBeUndefined();
	expect(cached(captures, 'one').sha256).toBe(
		expectOk(await harness.folder.files.read(PATH)).sha256,
	);
	expect(harness.failures).toEqual([]);
});

test('rapid edits run one save at a time, and the changes made meanwhile go in one more save', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, counter } = harness;
	const form = captures.formOf('one');
	const { held, release } = harness.holdNextMarkdownWrite();
	typeText(form, 'T');
	await held;
	const before = counter.mdWrites;
	for (const text of ['Ty', 'Typ', 'Typi', 'Typing']) typeText(form, text);
	expect(savesRunning(harness)).toBe(1);
	release();
	await quiet(captures);
	expect(harness.failures).toEqual([]);
	// The held save, then one save of the newest text, from the version it wrote.
	expect(counter.mdWrites - before).toBe(1);
	expect(await harness.text(PATH)).toContain('\nTyping\n');
	expect(harness.replaced).toEqual([]);
});

test('a change reported elsewhere reads the view again, and never replaces an edit not saved yet', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const form = captures.formOf('one');
	const { held, release } = harness.holdNextMarkdownWrite();
	typeText(form, 'Mine');
	await held;
	typeText(form, 'Mine, more');
	// The channel reports a change while the save is held: the view reads
	// the file again, which still holds the version before the save.
	await captures.queryClient.invalidateQueries(
		captures.folder$.pathFilter([PATH]),
	);
	expect(cached(captures, 'one').row.body).toContain('\nText\n');
	expect(form.body).toContain('\nMine, more\n');
	release();
	await quiet(captures);
	expect(form.body).toBeUndefined();
	expect(harness.failures).toEqual([]);
	expect(cached(captures, 'one').row.body).toContain('\nMine, more\n');
	expect(await harness.text(PATH)).toContain('\nMine, more\n');
	// Another page adds a thought: once reported, the view shows it, and the
	// next edit saves over it.
	await harness.writeElsewhere(PATH, `${await harness.text(PATH)}- theirs\n`);
	await harness.reportChange(PATH);
	expect(cached(captures, 'one').row.body).toContain('- theirs');
	typeText(form, 'Mine again');
	await quiet(captures);
	const saved = await harness.text(PATH);
	expect(saved).toContain('\nMine again\n');
	expect(saved).toContain('- theirs');
	expect(harness.replaced).toEqual([]);
});

test('a save that meets a change made elsewhere merges with it: the edit wins where both changed', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`;
	await harness.writeElsewhere(PATH, theirs);
	typeText(captures.formOf('one'), 'Mine');
	await quiet(captures);
	expect(harness.failures).toEqual([]);
	// Both changed the text line, so the edit's stands. Only they removed
	// `custom` and the thoughts, so those stay removed.
	const merged = await harness.text(PATH);
	expect(merged).toContain('\nMine\n');
	expect(merged).not.toContain('Theirs');
	expect(merged).not.toContain('custom: kept');
	expect(merged).not.toContain('- first');
	// The save names what of theirs it replaced.
	expect(harness.replaced).toMatchObject([
		{
			path: PATH,
			replaced: [expect.objectContaining({ kind: 'text', part: 'body' })],
		},
	]);

	// Restoring theirs is one more save, over the version this one wrote.
	harness.replaced[0]?.restore();
	await quiet(captures);
	expect(harness.failures).toEqual([]);
	expect(await harness.text(PATH)).toContain('\nTheirs\n');
	expect(await harness.text(PATH)).not.toContain('\nMine\n');
});

test('a save that fails keeps the edit and reports it, and the next change sends it again', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const form = captures.formOf('one');
	harness.failNextWrite(PATH);
	typeText(form, 'First');
	await quiet(captures);
	expect(harness.failures.map((failure) => failure.text)).toEqual([
		expect.stringContaining('\nFirst\n'),
	]);
	expect(await harness.text(PATH)).toBe(HAND);
	expect(form.body).toContain('\nFirst\n');
	expect(captures.unsettled).toBe(true);

	typeText(form, 'Second');
	await quiet(captures);
	expect(harness.failures).toHaveLength(1);
	expect(form.body).toBeUndefined();
	expect(await harness.text(PATH)).toContain('\nSecond\n');
});

test('a save to a file deleted elsewhere drops the edit, reports its text, and the capture is gone', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	captures.open('one', 'capture');
	await harness.deleteElsewhere(PATH);
	const form = captures.formOf('one');
	typeText(form, 'Mine');
	await quiet(captures);
	expect(harness.failures).toMatchObject([
		{
			path: PATH,
			error: { name: 'NotFound' },
			text: expect.stringContaining('\nMine\n'),
		},
	]);
	expect(form.body).toBeUndefined();
	// A save never recreates a deleted file.
	expect(await harness.text(PATH)).toBeUndefined();
	expect(listing(captures)).toEqual([]);
});

test('a change the body cannot hold is refused with the reason, and nothing is written', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, counter } = harness;
	const form = captures.formOf('one');
	const before = counter.mdWrites;
	// An open fence would absorb the Thoughts section.
	typeText(form, '```\nopen fence');
	expect(form.refusal).toContain('would not read back');
	expect(cached(captures, 'one').row.body).toContain('\nText\n');
	await quiet(captures);
	expect(counter.mdWrites).toBe(before);
});

test('an invalid row opens as text, is written as typed, and opens as a capture once repaired', async () => {
	const broken = '---\ncapturedAt: nope\n---\n\nBroken\n\n## Thoughts\n';
	const harness = await open({ [PATH]: broken });
	const { captures } = harness;
	expect(timelineOf(listing(captures)).repairs.map((row) => row.stem)).toEqual([
		'one',
	]);

	// Asked as a capture, it opens as text.
	captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'text' });
	const stop = observe(captures, PATH);
	await quiet(captures);
	expect(cachedText(captures, PATH)).toBe(broken);
	// Invalid text is written exactly as typed.
	const still = '---\ncapturedAt: still nope\n---\n\nBroken\n\n## Thoughts\n';
	typeFile(captures, PATH, still);
	await quiet(captures);
	expect(await harness.text(PATH)).toBe(still);

	const repaired = `---\ncapturedAt: ${AT}\n---\n\nRepaired\n\n## Thoughts\n`;
	typeFile(captures, PATH, repaired);
	await quiet(captures);
	stop();
	expect(harness.failures).toEqual([]);
	expect(await harness.text(PATH)).toBe(repaired);
	// The listing is read again after the write: the text decides whether it is a capture.
	expect(timelineOf(listing(captures)).repairs).toEqual([]);
	await captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'capture' });
});

test('a valid row whose Thoughts layout is ambiguous opens as text too', async () => {
	const ambiguous = `---\ncapturedAt: ${AT}\n---\n\n## Thoughts\n\n## Thoughts\n`;
	const { captures } = await open({ [PATH]: ambiguous });
	captures.open('one', 'capture');
	expect(captures.opened).toEqual({ stem: 'one', mode: 'text' });
});

test('a write of the text that meets a change made elsewhere merges with it by line', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	captures.open('one', 'text');
	const stop = observe(captures, PATH);
	await quiet(captures);
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n`;
	await harness.writeElsewhere(PATH, theirs);
	typeFile(captures, PATH, `${HAND}- mine\n`);
	await quiet(captures);
	stop();
	// Their changes and the added line do not compete, so both stand, and
	// nothing of theirs was replaced. A row is written in its standard form.
	const merged = `---\ncapturedAt: "${AT}"\n---\n\nTheirs\n- mine\n`;
	expect(harness.failures).toEqual([]);
	expect(harness.replaced).toEqual([]);
	expect(captures.typedText(PATH)).toBeUndefined();
	expect(cachedText(captures, PATH)).toBe(merged);
	expect(await harness.text(PATH)).toBe(merged);
});

test('a write of the text to a file deleted elsewhere drops the typed text, and reports it', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	captures.open('one', 'text');
	const stop = observe(captures, PATH);
	await quiet(captures);
	await harness.deleteElsewhere(PATH);
	typeFile(captures, PATH, `${HAND}- mine\n`);
	await quiet(captures);
	stop();
	expect(harness.failures).toMatchObject([
		{ path: PATH, error: { name: 'NotFound' }, text: `${HAND}- mine\n` },
	]);
	expect(captures.typedText(PATH)).toBeUndefined();
	expect(await harness.text(PATH)).toBeUndefined();
});

// ============================================================================
// Input not added yet
// ============================================================================

test('a thought typed and not added stays with its capture while another opens, and nothing asks', async () => {
	const harness = await open({ [PATH]: HAND, 'captures/two.md': HAND });
	const { captures } = harness;
	captures.open('one', 'capture');
	captures.formOf('one').inputNewThought('not added');
	expect(captures.unsettled).toBe(true);
	captures.open('two', 'capture');
	expect(captures.opened).toEqual({ stem: 'two', mode: 'capture' });
	captures.leave();
	captures.open('one', 'capture');
	expect(captures.formOf('one').newThought).toBe('not added');
	expect(await harness.text(PATH)).toBe(HAND);
});

test('a thought edit whose thought changed meanwhile is refused and keeps its text', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const form = captures.formOf('one');
	form.startEditing(0, ['first\nnested line']);
	const edit = form.editing;
	if (edit === undefined) throw new Error('the edit did not start');
	await harness.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- changed elsewhere\n`,
	);
	await harness.reportChange(PATH);
	form.inputEditing('my edit', edit.id);
	expect(form.commitEditing(edit.id)).toBe(false);
	expect(form.refusal).toContain('changed since they were shown');
	expect(form.editing?.text).toBe('my edit');
	await quiet(captures);
	expect(await harness.text(PATH)).toContain('- changed elsewhere');
});

test('deleting or moving a thought from a list that changed meanwhile says why', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const form = captures.formOf('one');
	const shown = ['first\nnested line'];
	await harness.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- a\n- b\n`,
	);
	await harness.reportChange(PATH);
	expect(form.deleteThought(0, shown)).toBe(false);
	expect(form.refusal).toContain('changed since they were shown');
	expect(form.swapThoughts(0, 1, ['b', 'a'])).toBe(false);
	expect(form.swapThoughts(0, 1, ['a', 'b'])).toBe(true);
	await quiet(captures);
	expect(await harness.text(PATH)).toContain('- b\n- a\n');
});

// ============================================================================
// Deleting
// ============================================================================

test('a delete runs after the edit is saved and removes what it saved', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	captures.open('one', 'capture');
	const deletion = expectOk(await captures.deletionFor('one'));
	expect(deletion).toMatchObject({ path: PATH, title: 'Text' });
	// Typing while the confirmation is open is written first.
	const { held, release } = harness.holdNextMarkdownWrite();
	typeText(captures.formOf('one'), 'Saving while deleted');
	await held;
	const removing = captures.remove(deletion);
	await Bun.sleep(5);
	expect(captures.isRemoving(PATH)).toBe(true);
	// Edits wait while the delete runs.
	captures.formOf('one').inputNewThought('Later');
	expect(captures.formOf('one').addThought()).toBe(false);
	release();
	expectOk(await removing);
	await quiet(captures);
	expect(harness.failures).toEqual([]);
	expect(await harness.text(PATH)).toBeUndefined();
	expect(captures.opened).toBeUndefined();
	expect(listing(captures)).toEqual([]);
});

test('a capture changed elsewhere is not deleted, and the timeline shows it as it is now', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const deletion = expectOk(await captures.deletionFor('one'));
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`;
	await harness.writeElsewhere(PATH, theirs);
	expect(expectErr(await captures.remove(deletion)).name).toBe('Conflict');
	await quiet(captures);
	expect(await harness.text(PATH)).toBe(theirs);
	expect(timelineOf(listing(captures)).rows[0]?.preview).toBe('Theirs');
});

// ============================================================================
// Versions
// ============================================================================

test('saves never commit; Save version records one, and delete says when changes are in no saved version', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, folder } = harness;
	const form = captures.formOf('one');
	typeText(form, 'Edited');
	form.inputNewThought('another');
	form.addThought();
	await quiet(captures);
	await Bun.sleep(20);
	// Nothing commits on its own after edits.
	expect(captures.git.lastCommit).toBeUndefined();
	expect(expectOk(await folder.git.log(5))).toEqual([]);
	expect(expectOk(await captures.deletionFor('one'))).toMatchObject({
		unversioned: true,
	});

	const outcome = expectOk(await captures.saveVersion());
	expect(outcome.status).toBe('committed');
	const log = expectOk(await folder.git.log(5));
	expect(log.map((commit) => commit.oid)).toEqual([
		outcome.status === 'committed' ? outcome.oid : '',
	]);
	expect(expectOk(await captures.deletionFor('one'))).toMatchObject({
		unversioned: false,
	});

	typeText(form, 'Edited again');
	await quiet(captures);
	await Bun.sleep(20);
	expect(expectOk(await folder.git.log(5))).toHaveLength(1);
	expect(expectOk(await captures.deletionFor('one'))).toMatchObject({
		unversioned: true,
	});
});

test('Save version is refused while closing, as other actions are', async () => {
	const { captures } = await open({ [PATH]: HAND });
	void captures.close();
	expect(expectErr(await captures.saveVersion()).message).toContain('closing');
});

// ============================================================================
// Closing
// ============================================================================

test('close waits for a write already sent and the newest edit after it, and every call shares one completion', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const form = captures.formOf('one');
	const { held, release } = harness.holdNextMarkdownWrite();
	typeText(form, 'Sent');
	await held;
	typeText(form, 'Typed later');
	let closed = false;
	const first = captures.close();
	expect(captures.close()).toBe(first);
	void first.then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	release();
	await first;
	expect(await harness.text(PATH)).toContain('\nTyped later\n');
	// After close, edits change nothing.
	typeText(form, 'After close');
	expect(form.body).toBeUndefined();
	expect(await harness.text(PATH)).toContain('\nTyped later\n');
});
