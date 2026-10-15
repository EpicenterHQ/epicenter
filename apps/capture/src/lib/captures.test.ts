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
 * - An edit changes the cache at once and is written to the file, keeping
 *   metadata Capture does not declare
 * - Rapid edits run one write at a time with one waiting; the waiting write
 *   saves the newest row, guarded by the hash the previous write confirmed
 * - No read starts while a write runs: not on returning to the window, not
 *   when a view mounts
 * - A write that fails rolls the cache back to the file and reports the
 *   text that was lost; a change the body or the folder cannot hold is
 *   refused
 * - A file that is not a valid capture opens as text, is written as typed,
 *   and opens as a capture once repaired
 * - A thought typed and not added stays with its capture; a thought command
 *   on a list that changed meanwhile is refused and keeps its text
 * - Deleting runs after the queued writes and removes what they saved; a
 *   file changed elsewhere since is not deleted
 * - Saves never commit; Save version records one
 * - Close fences input and waits for every mutation
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readLegacyBundle } from '@epicenter/capture/legacy';
import { expectErr, expectOk } from 'wellcrafted/testing';
import fixture from '../../fixtures/legacy-bundle.json';
import { openCaptures } from './browser-folder.test-support.js';
import {
	cached,
	cachedText,
	focusManager,
	listing,
	observe,
	quiet,
} from './query.test-support.js';

const { capturesKeys, timelineOf } = await import('./captures.svelte.ts');

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

/** Read everything again, as returning to the window does. */
async function returnToWindow(harness: Opened) {
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	await Bun.sleep(0);
	await quiet(harness.captures);
}

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
	await returnToWindow(harness);
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
	await returnToWindow(harness);
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

// ============================================================================
// Edits and writes
// ============================================================================

test('an edit changes the cache at once and is written to the file, keeping metadata Capture does not declare', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	captures.open('one', 'capture');
	const form = captures.formOf('one');
	form.inputNewThought('second');
	expect(form.addThought()).toBe(true);
	form.inputText('Edited');
	expect(cached(captures, 'one').row.body).toContain('\nEdited\n');
	await quiet(captures);
	expect(await harness.text(PATH)).toBe(
		`${FORMATTED.replace('\nText\n', '\nEdited\n')}- second\n`,
	);
	expect(cached(captures, 'one').sha256).toBe(
		expectOk(await harness.folder.files.read(PATH)).sha256,
	);
	expect(harness.failures).toEqual([]);
});

test('rapid edits run one write at a time with one waiting, which saves the newest text with no conflict', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, counter } = harness;
	const form = captures.formOf('one');
	const { held, release } = harness.holdNextMarkdownWrite();
	form.inputText('T');
	await held;
	const before = counter.mdWrites;
	for (const text of ['Ty', 'Typ', 'Typi', 'Typing']) form.inputText(text);
	// One write runs and one waits; no more were queued.
	expect(
		captures.queryClient.isMutating({ mutationKey: capturesKeys.write(PATH) }),
	).toBe(2);
	release();
	await quiet(captures);
	expect(harness.failures).toEqual([]);
	// The held write, then one write of the newest text.
	expect(counter.mdWrites - before).toBe(1);
	expect(await harness.text(PATH)).toContain('\nTyping\n');

	// The guard moved forward: the next edit writes on top.
	form.inputText('Typing more');
	await quiet(captures);
	expect(harness.failures).toEqual([]);
	expect(await harness.text(PATH)).toContain('\nTyping more\n');
});

test('no read starts while a write runs: not on returning to the window, not when a view mounts', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const form = captures.formOf('one');
	const { held, release } = harness.holdNextMarkdownWrite();
	form.inputText('Mine');
	await held;
	// Returning to the window while the write is held reads nothing.
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	// The client refetches on focus a tick later, after resuming paused writes.
	await Bun.sleep(0);
	// Neither does a view that mounts now.
	const mounted = observe(captures);
	expect(captures.queryClient.isFetching({ queryKey: capturesKeys.rows })).toBe(
		0,
	);
	release();
	await quiet(captures);
	mounted();
	expect(captures.formOf('one')).toBe(form);
	expect(cached(captures, 'one').row.body).toContain('\nMine\n');
	expect(cached(captures, 'one').sha256).toBe(
		expectOk(await harness.folder.files.read(PATH)).sha256,
	);
	form.inputText('Mine again');
	await quiet(captures);
	expect(harness.failures).toEqual([]);
	expect(await harness.text(PATH)).toContain('\nMine again\n');
});

test('a write that meets a change made elsewhere rolls back to the file and reports the lost text', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`;
	await harness.writeElsewhere(PATH, theirs);
	captures.formOf('one').inputText('Mine');
	await quiet(captures);
	expect(harness.failures).toHaveLength(1);
	expect(harness.failures[0]).toMatchObject({
		path: PATH,
		error: { name: 'Conflict' },
	});
	expect(harness.failures[0]?.lost).toContain('\nMine\n');
	// The cache shows the file again; nothing was written over it.
	expect(await harness.text(PATH)).toBe(theirs);
	expect(cached(captures, 'one').row.body).toContain('Theirs');

	// The next edit writes on top of what is there now.
	captures.formOf('one').inputText('Mine, again');
	await quiet(captures);
	expect(harness.failures).toHaveLength(1);
	expect(await harness.text(PATH)).toContain('\nMine, again\n');
});

test('a write that fails rolls back, and the write waiting behind it leaves the file as it was', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	const form = captures.formOf('one');
	harness.failNextWrite(PATH);
	form.inputText('First');
	form.inputText('Second');
	expect(
		captures.queryClient.isMutating({ mutationKey: capturesKeys.write(PATH) }),
	).toBe(2);
	await quiet(captures);
	// The rollback lands before the waiting write runs, so it saves the
	// file's own row and fails nothing.
	expect(harness.failures.map((failure) => failure.lost)).toEqual([
		expect.stringContaining('\nSecond\n'),
	]);
	// What it saves is the file's own row, with its frontmatter in the standard form.
	expect(await harness.text(PATH)).toBe(FORMATTED);
	expect(cached(captures, 'one').row.body).toContain('\nText\n');
});

test('a write to a file deleted elsewhere rolls back and the capture is gone', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	captures.open('one', 'capture');
	await harness.deleteElsewhere(PATH);
	captures.formOf('one').inputText('Mine');
	await quiet(captures);
	expect(harness.failures).toMatchObject([
		{ path: PATH, error: { name: 'Conflict', actualSha256: undefined } },
	]);
	// A write never recreates a deleted file.
	expect(await harness.text(PATH)).toBeUndefined();
	expect(listing(captures)).toEqual([]);
});

test('a change the body cannot hold is refused with the reason, and nothing is written', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, counter } = harness;
	const form = captures.formOf('one');
	const before = counter.mdWrites;
	// An open fence would absorb the Thoughts section.
	form.inputText('```\nopen fence');
	expect(form.refusal).toContain('would not read back');
	expect(cached(captures, 'one').row.body).toContain('\nText\n');
	await quiet(captures);
	expect(counter.mdWrites).toBe(before);
});

test('the folder refuses a value it cannot hold, and the cache rolls back', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	// Inputs commit only values the schema accepts; this bypasses them.
	captures.edit('one', (row) => ({
		...row,
		fields: {
			...row.fields,
			capturedAt: 'not a date' as (typeof row.fields)['capturedAt'],
		},
	}));
	await quiet(captures);
	expect(harness.failures).toMatchObject([
		{ path: PATH, error: { name: 'InvalidValues' } },
	]);
	expect(await harness.text(PATH)).toBe(HAND);
	expect<string>(cached(captures, 'one').row.fields.capturedAt).toBe(AT);
});

// ============================================================================
// Repair as text
// ============================================================================

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
	captures.editText(PATH, still);
	await quiet(captures);
	expect(await harness.text(PATH)).toBe(still);

	const repaired = `---\ncapturedAt: ${AT}\n---\n\nRepaired\n\n## Thoughts\n`;
	captures.editText(PATH, repaired);
	await quiet(captures);
	stop();
	expect(harness.failures).toEqual([]);
	expect(await harness.text(PATH)).toBe(repaired);
	// The listing is read again after the write.
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

test('a write of the text that meets a change made elsewhere rolls back and reports the text', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	captures.open('one', 'text');
	const stop = observe(captures, PATH);
	await quiet(captures);
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n`;
	await harness.writeElsewhere(PATH, theirs);
	captures.editText(PATH, `${HAND}- mine\n`);
	await quiet(captures);
	stop();
	expect(harness.failures).toMatchObject([
		{ path: PATH, error: { name: 'Conflict' }, lost: `${HAND}- mine\n` },
	]);
	expect(cachedText(captures, PATH)).toBe(theirs);
	expect(await harness.text(PATH)).toBe(theirs);
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
	await returnToWindow(harness);
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
	await returnToWindow(harness);
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

test('a delete runs after the queued writes and removes what they saved', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	captures.open('one', 'capture');
	const deletion = expectOk(await captures.deletionFor('one'));
	expect(deletion).toMatchObject({ path: PATH, title: 'Text' });
	// Typing while the confirmation is open is written first.
	const { held, release } = harness.holdNextMarkdownWrite();
	captures.formOf('one').inputText('Saving while deleted');
	await held;
	const removing = captures.remove(deletion);
	await Bun.sleep(5);
	expect(captures.isRemoving(PATH)).toBe(true);
	// Edits wait while the delete runs.
	expect(captures.edit('one', (row) => row)).toBe(false);
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
	form.inputText('Edited');
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

	form.inputText('Edited again');
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
	form.inputText('Sent');
	await held;
	form.inputText('Typed later');
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
	form.inputText('After close');
	expect(cached(captures, 'one').row.body).toContain('\nTyped later\n');
});

test('importing an export twice adds nothing the second time', async () => {
	const read = readLegacyBundle(fixture);
	if (!read.ok) throw new Error('the fixture is not a bundle');
	const { captures } = await open();
	const first = expectOk(await captures.importLegacy(read.bundle));
	expect(first.complete).toBe(true);
	await quiet(captures);
	expect(listing(captures)).toHaveLength(first.documents.length);
	const again = expectOk(await captures.importLegacy(read.bundle));
	expect(again.documents).toEqual([]);
	await quiet(captures);
	expect(listing(captures)).toHaveLength(first.documents.length);
});
