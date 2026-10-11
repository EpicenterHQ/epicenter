/**
 * Capture Store Tests
 *
 * Drives the real Capture store against a real browser folder over an
 * in-memory OPFS stand-in.
 *
 * Key behaviors:
 * - Creating a capture writes its text and an empty Thoughts section, and
 *   opens it; listing and opening write nothing
 * - The timeline orders by the captured instant, names files that are not
 *   captures for repair as text, and lists unreadable files apart
 * - Each change to the open capture saves the whole row at once, keeping
 *   metadata Capture does not declare; rapid typing writes the latest draft
 * - A draft that is not a valid capture is never written
 * - A save that meets a change made elsewhere merges with it: independent
 *   changes are written with no question; parts both changed wait in a
 *   review, and `resolve` writes one choice for each. A file deleted
 *   elsewhere is one part: taking the draft creates it again, taking the
 *   deletion closes it
 * - A file that is not a valid capture opens as text, saves as typed, and
 *   reopens as a capture once repaired
 * - Leaving a capture whose save failed, or with a thought typed and not
 *   added, answers `unsaved` until the person discards that session; opening
 *   the capture already shown does nothing; a discard after resolving
 *   reopened it as text applies to the session answered
 * - Deleting waits for the open capture's saves and deletes what it saved
 *   last; a file changed elsewhere since is not deleted
 * - Returning adopts a newer version of an open capture that holds nothing
 *   unsaved, and a thought edit whose thought changed keeps its text
 * - A departure refuses input, settles saves, counts what would be lost, and
 *   gives everything back; close waits for saves
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readLegacyBundle } from '@epicenter/capture/legacy';
import fixture from '../../fixtures/legacy-bundle.json';
import {
	openCapture,
	openCaptures,
	openText,
	takeAll,
} from './browser-folder.test-support.js';

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
const PATH = 'captures/one.md';

/** Create a capture through the New capture form; it opens. */
async function create(harness: Opened, text: string) {
	harness.captures.inputNewCapture(text);
	expect(await harness.captures.create()).toBeUndefined();
	return openCapture(harness.captures);
}

// ============================================================================
// Creating and listing
// ============================================================================

test('creating writes the text and an empty Thoughts section, opens it, and clears the form', async () => {
	const harness = await open();
	const { captures, counter } = harness;
	const { session, form } = await create(harness, 'Exact\n  text ');
	expect(captures.newCapture).toBe('');
	expect(await harness.text(session.path)).toMatch(
		/^---\ncapturedAt: "[^"]+"\n---\n\nExact\n {2}text \n\n## Thoughts\n$/,
	);
	expect(form.text).toBe('Exact\n  text ');
	expect(form.thoughts).toEqual([]);
	expect(captures.timeline.map((row) => row.path)).toEqual([session.path]);

	// Listing and opening again write nothing.
	const before = counter.mdWrites;
	await captures.leave();
	await captures.refresh();
	await captures.open(captures.timeline[0]!.stem, 'capture');
	expect(counter.mdWrites).toBe(before);
});

test('blank New capture text is refused and stays in the form', async () => {
	const { captures } = await open();
	captures.inputNewCapture('   ');
	expect(await captures.create()).toBe('Write something first.');
	expect(captures.newCapture).toBe('   ');
	expect(captures.unsettled).toBe(1);
});

test('the timeline orders by the instant across offsets, names files to repair, and lists unreadable ones apart', async () => {
	const { captures, folder } = await open({
		'captures/utc.md': '---\ncapturedAt: 2026-10-01T03:00:00Z\n---\n\nUTC\n',
		'captures/east.md': `---\ncapturedAt: ${AT}\n---\n\nEast\n`,
		'captures/nodate.md': '---\ncapturedAt: nope\n---\n\nNo date\n',
		'captures/two-headings.md':
			'---\ncapturedAt: 2026-10-01T03:00:00Z\n---\n\n## Thoughts\n\n## Thoughts\n',
	});
	await folder.files.create('captures/binary.md', new Uint8Array([0xff, 0xfe]));
	await captures.refresh();
	// 10:30+08:00 is 02:30Z, before 03:00Z.
	expect(captures.timeline.map((row) => row.preview)).toEqual(['UTC', 'East']);
	expect(captures.repairs.map((row) => row.path)).toEqual([
		'captures/nodate.md',
		'captures/two-headings.md',
	]);
	expect(captures.repairs[0]?.problem).toContain('capturedAt');
	expect(captures.repairs[1]?.problem).toContain('Thoughts');
	expect(captures.unreadable).toEqual([
		{ path: 'captures/binary.md', message: 'It is not UTF-8 text.' },
	]);
});

// ============================================================================
// Saving the open capture
// ============================================================================

test('each change saves the whole row at once, keeping metadata Capture does not declare', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	expect(form.text).toBe('Text');
	expect(form.thoughts).toEqual(['first\nnested line']);

	form.inputNewThought('second');
	expect(form.addThought()).toBe(true);
	form.inputText('Edited');
	expect((await session.settled()).status).toBe('saved');
	expect(await harness.text(PATH)).toBe(
		'---\ncapturedAt: "2026-10-01T10:30:00+08:00"\ncustom: kept\n---\n\nEdited\n\n## Thoughts\n\n- first\n  nested line\n- second\n',
	);
});

test('rapid typing writes only the latest draft', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, counter } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	const { held, release } = harness.holdNextMarkdownWrite();
	form.inputText('T');
	await held;
	const before = counter.mdWrites;
	for (const text of ['Ty', 'Typ', 'Typi', 'Typing']) form.inputText(text);
	expect(session.state.status).toBe('saving');
	release();
	expect((await session.settled()).status).toBe('saved');
	// The held write, then one write of the latest draft.
	expect(counter.mdWrites - before).toBe(1);
	expect(await harness.text(PATH)).toContain('\nTyping\n');
	expect(form.text).toBe('Typing');
});

test('a draft that is not a valid capture is never written, and the next valid edit saves', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	session.edit((row) => {
		row.fields.capturedAt = 'not a date' as typeof row.fields.capturedAt;
	});
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('InvalidValues');
	expect(await harness.text(PATH)).toBe(HAND);
	session.edit((row) => {
		row.fields.capturedAt = AT as typeof row.fields.capturedAt;
	});
	form.inputText('Fixed');
	expect((await session.settled()).status).toBe('saved');
	expect(await harness.text(PATH)).toContain('\nFixed\n');
});

test('a change the body cannot hold is refused with the reason, and nothing is written', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, counter } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	const before = counter.mdWrites;
	// An open fence would absorb the Thoughts section.
	form.inputText('```\nopen fence');
	expect(form.refusal).toContain('would not read back');
	expect(form.text).toBe('Text');
	await session.settled();
	expect(counter.mdWrites).toBe(before);
});

// ============================================================================
// A change made elsewhere
// ============================================================================

test('a save merges with an independent change made elsewhere and asks nothing', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	await harness.writeElsewhere(PATH, `${HAND}- theirs\n`);
	form.inputText('Mine');
	expect((await session.settled()).status).toBe('saved');
	expect(session.review).toBeUndefined();
	expect(form.text).toBe('Mine');
	expect(form.thoughts).toEqual(['first\nnested line', 'theirs']);
	const saved = await harness.text(PATH);
	expect(saved).toContain('\nMine\n');
	expect(saved).toContain('- theirs\n');
	expect(saved).toContain('custom: kept');
});

test('a body both changed waits in a review; taking theirs shows it and keeps the independent field change', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`;
	await harness.writeElsewhere(PATH, theirs);
	form.inputText('Mine');
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(session.review?.conflicts.map((conflict) => conflict.kind)).toEqual([
		'body',
	]);
	// Nothing is written until the review is answered.
	expect(await harness.text(PATH)).toBe(theirs);

	expect(
		await captures.resolve(session, takeAll(session, 'incoming')),
	).toBeUndefined();
	expect(session.review).toBeUndefined();
	expect(form.text).toBe('Theirs');
	expect(form.thoughts).toEqual([]);
	expect(session.state.status).toBe('saved');
	// Their text already holds everything chosen: their body and their
	// removal of `custom`.
	expect(await harness.text(PATH)).toBe(theirs);
	// The session saves again from what it resolved.
	form.inputText('After');
	expect((await session.settled()).status).toBe('saved');
	expect(await harness.text(PATH)).toContain('\nAfter\n');
});

test('a body both changed: taking the draft saves it over the change made elsewhere', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	await harness.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`,
	);
	form.inputText('Mine');
	await session.settled();
	expect(
		await captures.resolve(session, takeAll(session, 'local')),
	).toBeUndefined();
	expect((await session.settled()).status).toBe('saved');
	expect(session.review).toBeUndefined();
	const saved = await harness.text(PATH);
	expect(saved).toContain('\nMine\n');
	expect(saved).toContain('- first\n  nested line');
});

test('a choice the folder refuses keeps the review with its problem', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`;
	await harness.writeElsewhere(PATH, theirs);
	form.inputText('Mine');
	await session.settled();
	const review = session.review;
	expect(await captures.resolve(session, {})).toBeString();
	expect(session.review?.id).toBe(review?.id);
	expect(session.review?.problems.length).toBeGreaterThan(0);
	expect(await harness.text(PATH)).toBe(theirs);
});

test('a file deleted elsewhere waits in a review; taking the draft creates it again', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	await harness.deleteElsewhere(PATH);
	form.inputText('Still mine');
	const state = await session.settled();
	expect(
		state.status === 'error' &&
			state.error.name === 'Conflict' &&
			state.error.actualSha256,
	).toBeUndefined();
	expect(session.review?.conflicts).toEqual([
		expect.objectContaining({ kind: 'file', incoming: { present: false } }),
	]);
	// A save never recreates a deleted file on its own.
	expect(await harness.text(PATH)).toBeUndefined();

	expect(
		await captures.resolve(session, takeAll(session, 'local')),
	).toBeUndefined();
	expect(await harness.text(PATH)).toContain('\nStill mine\n');
	expect(session.state.status).toBe('saved');
	form.inputText('After');
	expect((await session.settled()).status).toBe('saved');
});

test('a file deleted elsewhere: taking the deletion closes it without writing', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	await harness.deleteElsewhere(PATH);
	form.inputText('Mine');
	await session.settled();
	expect(
		await captures.resolve(session, takeAll(session, 'incoming')),
	).toBeUndefined();
	expect(captures.opened).toBeUndefined();
	// The closed session takes nothing more.
	form.inputText('Late');
	await session.settled();
	expect(await harness.text(PATH)).toBeUndefined();
	expect(captures.timeline).toEqual([]);
});

test('a capture made invalid elsewhere: taking their text opens it as text with the issues', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	await harness.writeElsewhere(PATH, '---\ncapturedAt: [unclosed\n---\n');
	form.inputText('Mine');
	await session.settled();
	expect(session.review?.conflicts.map((conflict) => conflict.kind)).toEqual([
		'file',
	]);
	expect(
		await captures.resolve(session, takeAll(session, 'incoming')),
	).toBeUndefined();
	expect(openText(captures).draft).toBe('---\ncapturedAt: [unclosed\n---\n');
});

// ============================================================================
// Repair as text
// ============================================================================

test('an invalid row is named for repair, opens as text, saves as typed, and reopens as a capture', async () => {
	const broken = '---\ncapturedAt: nope\n---\n\nBroken\n\n## Thoughts\n';
	const harness = await open({ [PATH]: broken });
	const { captures } = harness;
	expect(captures.timeline).toEqual([]);
	expect(captures.repairs.map((row) => row.stem)).toEqual(['one']);

	// Asked as a capture, it opens as text.
	await captures.open('one', 'capture');
	const session = openText(captures);
	expect(session.draft).toBe(broken);
	session.input('---\ncapturedAt: still nope\n---\n\nBroken\n\n## Thoughts\n');
	expect((await session.settled()).status).toBe('saved');
	// Invalid text saves exactly as typed.
	expect(await harness.text(PATH)).toBe(
		'---\ncapturedAt: still nope\n---\n\nBroken\n\n## Thoughts\n',
	);
	session.input(`---\ncapturedAt: ${AT}\n---\n\nRepaired\n\n## Thoughts\n`);
	await session.settled();

	expect(await captures.open('one', 'capture')).toEqual({
		kind: 'done',
		left: true,
	});
	const { form } = openCapture(captures);
	expect(form.text).toBe('Repaired');
	await captures.refresh();
	expect(captures.repairs).toEqual([]);
	expect(captures.timeline.map((row) => row.preview)).toEqual(['Repaired']);
});

test('a valid row whose Thoughts layout is ambiguous opens as text too', async () => {
	const ambiguous = `---\ncapturedAt: ${AT}\n---\n\n## Thoughts\n\n## Thoughts\n`;
	const { captures } = await open({ [PATH]: ambiguous });
	await captures.open('one', 'capture');
	expect(openText(captures).draft).toBe(ambiguous);
});

test('Edit as text shows the exact file, and taking the draft there keeps their other changes', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'text');
	const session = openText(captures);
	expect(session.draft).toBe(HAND);
	await harness.writeElsewhere(PATH, `---\ncapturedAt: ${AT}\n---\n\nTheirs\n`);
	session.input(`${session.draft}- mine\n`);
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(
		await captures.resolve(session, takeAll(session, 'local')),
	).toBeUndefined();
	await session.settled();
	// The capture merges by field and body, as sync merges it: the body both
	// changed is mine, and their removal of `custom` stands.
	const saved = await harness.text(PATH);
	expect(saved).toEndWith('- mine\n');
	expect(saved).not.toContain('custom: kept');
	expect<string | undefined>(session.draft).toBe(saved);
});

// ============================================================================
// Leaving a capture
// ============================================================================

test('leaving waits for saves, and a failed save answers unsaved until it is discarded', async () => {
	const harness = await open({ [PATH]: HAND, 'captures/two.md': HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const one = openCapture(captures);
	harness.failNextWrite(PATH);
	one.form.inputText('Mine');
	expect(await captures.open('two', 'capture')).toEqual({
		kind: 'unsaved',
		session: one.session,
	});
	expect(openCapture(captures)).toBe(one);
	expect(captures.unsaved).toBe(true);

	// A discard names the session it lets go; any other answers unsaved again.
	const other = {} as typeof one.session;
	expect((await captures.leave({ discard: other })).kind).toBe('unsaved');
	expect(
		await captures.open('two', 'capture', { discard: one.session }),
	).toEqual({ kind: 'done', left: true });
	expect(openCapture(captures).stem).toBe('two');
	// The released session takes nothing more.
	one.form.inputText('Late');
	expect(one.form.text).toBe('Mine');
	expect(await harness.text(PATH)).toBe(HAND);
});

test('a thought typed and not added keeps the capture open until it is discarded', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	form.inputNewThought('not added');
	expect(captures.unsettled).toBe(1);
	expect((await captures.leave()).kind).toBe('unsaved');
	expect(await captures.leave({ discard: session })).toEqual({
		kind: 'done',
		left: true,
	});
	expect(captures.opened).toBeUndefined();
	expect(await harness.text(PATH)).toBe(HAND);
});

test('opening the capture already shown does nothing, even when it holds unsaved text', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures, counter } = harness;
	await captures.open('one', 'capture');
	const one = openCapture(captures);
	one.form.inputNewThought('not added');
	const before = counter.mdWrites;
	expect(await captures.open('one', 'capture')).toEqual({
		kind: 'done',
		left: false,
	});
	expect(openCapture(captures)).toBe(one);
	expect(one.form.newThought).toBe('not added');
	expect(one.session.locked).toBe(false);
	expect(counter.mdWrites).toBe(before);
});

test('a discard after resolving reopened the capture as text applies to the session answered', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const row = openCapture(captures);
	const invalid = '---\ncapturedAt: [unclosed\n---\n';
	await harness.writeElsewhere(PATH, invalid);
	row.form.inputText('Mine');
	await row.session.settled();
	// The row session cannot show the file now, so it opens again as text.
	expect(
		await captures.resolve(row.session, takeAll(row.session, 'incoming')),
	).toBeUndefined();
	const text = openText(captures);
	harness.failNextWrite(PATH);
	text.input(`${invalid}more\n`);
	await text.settled();

	const answered = await captures.leave();
	expect(answered).toEqual({ kind: 'unsaved', session: text });
	// The session from before the swap discards nothing.
	expect((await captures.leave({ discard: row.session })).kind).toBe('unsaved');
	expect(openText(captures)).toBe(text);
	if (answered.kind !== 'unsaved') throw new Error('expected unsaved');
	expect(await captures.leave({ discard: answered.session })).toEqual({
		kind: 'done',
		left: true,
	});
	expect(captures.opened).toBeUndefined();
	expect(await harness.text(PATH)).toBe(invalid);
});

test('leaving after an edit saves that edit first', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	openCapture(captures).form.inputText('Saved on the way out');
	expect(await captures.leave()).toEqual({ kind: 'done', left: true });
	expect(await harness.text(PATH)).toContain('\nSaved on the way out\n');
	expect(captures.timeline[0]?.preview).toBe('Saved on the way out');
});

// ============================================================================
// Deleting
// ============================================================================

test('deleting waits for the open capture saves and deletes what it saved last', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	const { held, release } = harness.holdNextMarkdownWrite();
	form.inputText('Saving while deleted');
	await held;
	const removing = captures.remove(session);
	release();
	expect(await removing).toBeUndefined();
	expect(await harness.text(PATH)).toBeUndefined();
	expect(captures.opened).toBeUndefined();
	expect(captures.timeline).toEqual([]);
});

test('a departure and close wait for a delete that is still waiting on a save', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	const { held, release } = harness.holdNextMarkdownWrite();
	form.inputText('Saving while deleted');
	await held;
	const order: string[] = [];
	const removing = captures.remove(session).then((problem) => {
		order.push('deleted');
		return problem;
	});
	captures.departure.fence();
	const settling = captures.departure.settle().then(() => {
		order.push('settled');
	});
	const closing = captures.close().then(() => {
		order.push('closed');
	});
	await Bun.sleep(5);
	expect(order).toEqual([]);
	release();
	await Promise.all([settling, closing]);
	// Both waited for the delete itself, not only for the save before it.
	expect(order[0]).toBe('deleted');
	expect(await removing).toBeUndefined();
	expect(await harness.text(PATH)).toBeUndefined();
});

test('a capture changed elsewhere is not deleted; it opens again as it is now', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session } = openCapture(captures);
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`;
	await harness.writeElsewhere(PATH, theirs);
	expect(await captures.remove(session)).toContain('changed elsewhere');
	expect(await harness.text(PATH)).toBe(theirs);
	expect(openCapture(captures).form.text).toBe('Theirs');
});

// ============================================================================
// Returning to the window
// ============================================================================

test('returning adopts a newer version of an open capture that holds nothing unsaved', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	await harness.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n\n- theirs\n`,
	);
	await captures.check();
	expect(form.text).toBe('Theirs');
	expect(form.thoughts).toEqual(['theirs']);
	expect(session.state.status).toBe('saved');
});

test('returning leaves a capture with a thought typed and not added; its next save meets the change in a review', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	form.inputNewThought('typed');
	await harness.writeElsewhere(PATH, `---\ncapturedAt: ${AT}\n---\n\nTheirs\n`);
	await captures.check();
	expect(form.text).toBe('Text');
	expect(form.addThought()).toBe(true);
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(session.review?.conflicts.map((conflict) => conflict.kind)).toEqual([
		'body',
	]);
});

test('a thought edit whose thought changed meanwhile is refused and keeps its text', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	form.startEditing(0, form.thoughts);
	const edit = form.editing!;
	// Unchanged text is nothing unsaved, so returning adopts the newer version.
	await harness.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- changed elsewhere\n`,
	);
	await captures.check();
	form.inputEditing('my edit', edit.id);
	expect(form.commitEditing(edit.id)).toBe(false);
	expect(form.refusal).toContain('changed since they were shown');
	expect(form.editing?.text).toBe('my edit');
	await session.settled();
	expect(await harness.text(PATH)).toContain('- changed elsewhere');
});

test('deleting or moving a thought from a list that changed meanwhile says why', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { form } = openCapture(captures);
	const shown = form.thoughts;
	await harness.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- a\n- b\n`,
	);
	await captures.check();
	expect(form.deleteThought(0, shown)).toBe(false);
	expect(form.refusal).toContain('changed since they were shown');
	expect(form.swapThoughts(0, 1, shown)).toBe(false);
	expect(form.refusal).toContain('changed since they were shown');
	expect(form.thoughts).toEqual(['a', 'b']);
});

// ============================================================================
// Departure and closing
// ============================================================================

test('a departure refuses input, settles saves, counts what would be lost, and gives everything back', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { session, form } = openCapture(captures);
	form.inputText('Saves on its own');
	form.inputNewThought('Held');
	captures.inputNewCapture('A new capture, not added');

	captures.departure.fence();
	expect(captures.fenced).toBe(true);
	expect(session.locked).toBe(true);
	form.inputText('refused');
	form.inputNewThought('refused');
	captures.inputNewCapture('refused');
	expect(await captures.create()).toContain('quit or restart');
	// The new thought and the New capture text would be lost.
	expect(await captures.departure.settle()).toBe(2);
	expect(await harness.text(PATH)).toContain('\nSaves on its own\n');

	captures.departure.resume();
	expect(session.locked).toBe(false);
	expect(form.newThought).toBe('Held');
	expect(captures.newCapture).toBe('A new capture, not added');
	expect(form.addThought()).toBe(true);
	expect((await session.settled()).status).toBe('saved');
});

test('a commit is refused while departing or closing, as other actions are', async () => {
	const { captures } = await open({ [PATH]: HAND });
	captures.departure.fence();
	expect(await captures.commit()).toEqual({
		status: 'blocked',
		reason: expect.stringContaining('quit or restart'),
	});
	captures.departure.resume();
	void captures.close();
	expect(await captures.commit()).toEqual({
		status: 'blocked',
		reason: expect.stringContaining('closing'),
	});
});

test('closing waits for a save already sent and the latest edit after it', async () => {
	const harness = await open({ [PATH]: HAND });
	const { captures } = harness;
	await captures.open('one', 'capture');
	const { form } = openCapture(captures);
	const { held, release } = harness.holdNextMarkdownWrite();
	form.inputText('Sent');
	await held;
	form.inputText('Typed later');
	let closed = false;
	const closing = captures.close().then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	release();
	await closing;
	expect(await harness.text(PATH)).toContain('\nTyped later\n');
	form.inputText('After close');
	expect(form.text).toBe('Typed later');
});

test('importing an export twice adds nothing the second time', async () => {
	const read = readLegacyBundle(fixture);
	if (!read.ok) throw new Error('the fixture is not a bundle');
	const { captures } = await open();
	const first = await captures.importLegacy(read.bundle);
	expect(first.complete).toBe(true);
	const imported = captures.timeline.length + captures.repairs.length;
	expect(imported).toBe(first.documents.length);
	const again = await captures.importLegacy(read.bundle);
	expect(again.documents).toEqual([]);
	expect(captures.timeline.length + captures.repairs.length).toBe(imported);
});
