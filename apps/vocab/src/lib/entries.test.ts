/**
 * Saved word tests.
 * The real entries state runs over Vocab's real browser folder on an
 * in-memory OPFS stand-in. "Saved" is read back from the file, and from the
 * folder opened again, never assumed from the list on screen.
 *
 * Key behaviors:
 * - A word is listed once its file exists, with a blank note and the New
 *   stage; one exact text is one file, whoever adds it and however often
 * - The open word saves each edit at once, and rapid typing writes only the
 *   latest draft; a draft that is not a valid word is never written
 * - A change made elsewhere is a conflict: Reload theirs shows it, Keep mine
 *   saves the draft over it. A file deleted elsewhere: Keep mine creates it
 *   again, Discard closes the word
 * - A file that is not a valid word is named for repair, opens as text,
 *   saves as typed, and reopens as a word once its text is valid
 * - Leaving a word whose save failed answers `unsaved` until the session the
 *   answer named is discarded; opening the open word again does nothing
 * - Returning adopts a newer version of an open word that holds nothing unsaved
 * - A stage pressed on a closed word is guarded by the version the list read
 * - Deleting the open word waits for its saves and removes what they saved
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Entry } from './data.js';
import {
	createBrowser,
	entriesOf,
	fileText,
	gated,
	tableFiles,
} from './folder.test-support.js';

const { createEntriesState } = await import('./entries.svelte.js');
type EntriesState = ReturnType<typeof createEntriesState>;

async function setup() {
	const browser = createBrowser();
	const folder = await browser.open();
	const entries = createEntriesState(entriesOf(folder));
	await entries.refresh();
	const { faults } = browser.opfs;
	let entryWrites = 0;
	let hold: PromiseWithResolvers<void> | undefined;
	let held: PromiseWithResolvers<void> | undefined;
	// Every stream opened under `entries/` is one write of a word file.
	faults.open = async (path) => {
		if (!path.includes('/entries/')) return;
		entryWrites++;
		const gate = hold;
		if (gate === undefined) return;
		hold = undefined;
		held?.resolve();
		await gate.promise;
	};
	return {
		browser,
		folder,
		entries,
		get entryWrites() {
			return entryWrites;
		},
		/** Hold the next word file write until `release` runs. */
		holdNextWrite() {
			hold = Promise.withResolvers<void>();
			held = Promise.withResolvers<void>();
			return { held: held.promise, release: hold.resolve };
		},
		/** The next write of `path` fails before it publishes. */
		failNextWrite(path: string) {
			faults.write = (key) => {
				if (!key.endsWith(`/${path}`)) return undefined;
				faults.write = undefined;
				return 'fail';
			};
		},
		/** The words a reload would list, from a folder opened again. */
		async reopened() {
			const again = createEntriesState(entriesOf(await browser.open()));
			await again.refresh();
			return again;
		},
		text: (path: string) => fileText(folder, path),
		/** Another program writes the file. */
		async writeElsewhere(path: string, content: string) {
			expectOk(await folder.files.overwrite(path, content));
		},
		/** Another program deletes the file as it is now. */
		async deleteElsewhere(path: string) {
			expectOk(
				await folder.files.remove(expectOk(await folder.files.read(path))),
			);
		},
		async [Symbol.asyncDispose]() {
			await entries.close();
			await browser[Symbol.asyncDispose]();
		},
	};
}

const summary = (state: {
	entries: readonly { text: string; note: string; stage: string }[];
}) => state.entries.map(({ text, note, stage }) => ({ text, note, stage }));

function listed(entries: EntriesState, text: string): Entry {
	const entry = entries.entries.find((candidate) => candidate.text === text);
	if (entry === undefined) throw new Error(`${text} is not listed`);
	return entry;
}

/** Add `text` and open it as a word. */
async function openWord(entries: EntriesState, text: string) {
	expectOk(await entries.add(text));
	const entry = listed(entries, text);
	expect((await entries.open(entry.id)).kind).toBe('done');
	return { entry, session: wordSession(entries) };
}

function wordSession(entries: EntriesState) {
	const item = entries.opened;
	if (item?.kind !== 'word')
		throw new Error(`Expected an open word, got ${item?.kind}`);
	return item.session;
}

function textSession(entries: EntriesState) {
	const item = entries.opened;
	if (item?.kind !== 'text')
		throw new Error(`Expected open text, got ${item?.kind}`);
	return item.session;
}

const wordText = (text: string, stage = 'new') =>
	`---\ntext: ${text}\nnote: theirs\nstage: ${stage}\ncreatedAt: 2026-10-03T00:00:00.000Z\n---\n`;

// ============================================================================
// Adding words
// ============================================================================

test('a word is listed once its file exists, with a blank note and the New stage, and is there after reopening', async () => {
	await using context = await setup();
	const { folder, entries } = context;

	const adding = entries.add('  lucid  ');
	expect(entries.entries).toEqual([]);
	expect(expectOk(await adding)).toBe('added');
	expect(summary(entries)).toEqual([{ text: 'lucid', note: '', stage: 'new' }]);
	expect(await tableFiles(folder, 'entries')).toEqual([
		listed(entries, 'lucid').stored.path,
	]);
	expect(summary(await context.reopened())).toEqual([
		{ text: 'lucid', note: '', stage: 'new' },
	]);
});

test('text is trimmed and otherwise exact in any script or spelling', async () => {
	await using context = await setup();
	const { entries } = context;
	const texts = [
		'é 和 é。',
		// The same letters spelled with a combining accent are another phrase.
		'é 和 é。',
		'银行，顺便买',
		'naïve — “quoted”: yes',
		'مرحبا بالعالم',
		'👩🏽‍🚀 to the 🌕',
		'a: b # not a comment',
	];
	expect(expectErr(await entries.add('   ')).name).toBe('Empty');
	for (const text of texts)
		expect(expectOk(await entries.add(text))).toBe('added');
	const sorted = [...texts].sort();
	expect(entries.entries.map((entry) => entry.text).sort()).toEqual(sorted);
	expect(
		(await context.reopened()).entries.map((entry) => entry.text).sort(),
	).toEqual(sorted);
});

test('a phrase with the exact text of a saved word writes nothing and leaves its note and stage alone', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	const { entry, session } = await openWord(entries, 'by and large');
	session.edit((row) => {
		row.fields.note = 'mostly';
		row.fields.stage = 'understood';
	});
	await session.settled();
	const before = await context.text(entry.stored.path);

	expect(expectOk(await entries.add(' by and large '))).toBe('present');
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
	expect(await context.text(entry.stored.path)).toBe(before);
});

test('adds of one text made together, in one tab or two, save one word', async () => {
	await using context = await setup();
	const { browser, folder, entries } = context;
	const otherTab = createEntriesState(entriesOf(await browser.open()));
	await otherTab.refresh();
	const outcomes = await Promise.all([
		entries.add('on the fence'),
		entries.add(' on the fence '),
		otherTab.add('on the fence'),
	]);
	expect(outcomes.map((outcome) => expectOk(outcome)).sort()).toEqual([
		'added',
		'present',
		'present',
	]);
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
	expect(summary(otherTab)).toEqual([
		{ text: 'on the fence', note: '', stage: 'new' },
	]);
	// A different text, however close, is another word.
	expect(expectOk(await entries.add('On the fence'))).toBe('added');
	expect(await tableFiles(folder, 'entries')).toHaveLength(2);
});

test('a refused add lists nothing; an add that landed without its answer is found by the retry', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, table } = gated(folder.tables.entries);
	const entries = createEntriesState({ table, files: folder.files });

	gate.failing = true;
	expect(expectErr(await entries.add('subtle')).name).toBe('NotSaved');
	expect(entries.entries).toEqual([]);
	expect(await tableFiles(folder, 'entries')).toEqual([]);
	gate.failing = false;

	gate.losingReceipt = true;
	expect(expectErr(await entries.add('subtle')).name).toBe('NotSaved');
	const files = await tableFiles(folder, 'entries');
	expect(files).toHaveLength(1);
	expect(expectOk(await entries.add('subtle'))).toBe('present');
	expect(await tableFiles(folder, 'entries')).toEqual(files);
	expect(summary(entries)).toEqual([
		{ text: 'subtle', note: '', stage: 'new' },
	]);
});

test('a different file where a new word belongs is refused and left as it is', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	expectOk(await entries.add('lucid'));
	const path = listed(entries, 'lucid').stored.path;
	const other = wordText('lurid');
	await context.writeElsewhere(path, other);

	const stale = createEntriesState(entriesOf(folder));
	expect(expectErr(await stale.add('lucid')).name).toBe('Taken');
	expect(await context.text(path)).toBe(other);
});

test('a word another tab removed is saved again instead of being called present', async () => {
	await using context = await setup();
	const { browser, folder, entries } = context;
	expectOk(await entries.add('resilient'));
	const otherTab = createEntriesState(entriesOf(await browser.open()));
	await otherTab.refresh();
	expect(await otherTab.remove(listed(otherTab, 'resilient'))).toBeUndefined();
	expect(entries.entries.some((entry) => entry.text === 'resilient')).toBe(
		true,
	);

	expect(expectOk(await entries.add('resilient'))).toBe('added');
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
});

// ============================================================================
// Saving the open word
// ============================================================================

test('each edit saves at once, and rapid typing writes only the latest draft', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	const { held, release } = context.holdNextWrite();
	entries.inputNote(entry.id, 'c');
	await held;
	const before = context.entryWrites;
	for (const note of ['cl', 'cle', 'clea', 'clear'])
		entries.inputNote(entry.id, note);
	expect(session.state.status).toBe('saving');
	release();
	expect((await session.settled()).status).toBe('saved');
	// The held write, then one write of the latest draft.
	expect(context.entryWrites - before).toBe(1);
	expect(await context.text(session.path)).toContain('note: clear');
	expect(entries.fieldsOf(entry).note).toBe('clear');
});

test('a draft that is not a valid word is never written, and the next valid edit saves', async () => {
	await using context = await setup();
	const { entries } = context;
	const { session } = await openWord(entries, 'lucid');
	const saved = await context.text(session.path);
	session.edit((row) => {
		(row.fields as { stage: string }).stage = 'mastered';
	});
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('InvalidValues');
	expect(await context.text(session.path)).toBe(saved);
	session.edit((row) => {
		row.fields.stage = 'usable';
	});
	expect((await session.settled()).status).toBe('saved');
	expect(await context.text(session.path)).toContain('stage: usable');
});

test('a note is kept well formed, so what saves is what is shown', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	entries.inputNote(entry.id, 'a\uD800b');
	expect((await session.settled()).status).toBe('saved');
	expect(session.draft.fields.note).toBe('a�b');
	expect(summary(await context.reopened())[0]?.note).toBe('a�b');
});

test('a failed save keeps the draft; Try again saves it', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	context.failNextWrite(session.path);
	entries.inputNote(entry.id, 'clear');
	expect((await session.settled()).status).toBe('error');
	expect(entries.unsaved).toBe(true);
	expect(session.draft.fields.note).toBe('clear');
	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(await context.text(session.path)).toContain('note: clear');
});

// ============================================================================
// The conflict prompt
// ============================================================================

test('a change made elsewhere is a conflict, and Reload theirs shows it without writing', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	const theirs = wordText('lucid', 'usable');
	await context.writeElsewhere(session.path, theirs);
	entries.inputNote(entry.id, 'mine');
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(await context.text(session.path)).toBe(theirs);

	expect(await entries.reloadTheirs(session)).toBeUndefined();
	expect(session.draft.fields).toMatchObject({
		note: 'theirs',
		stage: 'usable',
	});
	expect(session.state.status).toBe('saved');
	expect(await context.text(session.path)).toBe(theirs);
	entries.inputNote(entry.id, 'after');
	expect((await session.settled()).status).toBe('saved');
	expect(await context.text(session.path)).toContain('note: after');
});

test('Keep mine takes the draft where both changed and keeps what changed elsewhere in other fields', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	await context.writeElsewhere(session.path, wordText('lucid', 'usable'));
	entries.inputNote(entry.id, 'mine');
	await session.settled();
	expect(await entries.keepMine(session)).toBeUndefined();
	expect((await session.settled()).status).toBe('saved');
	const saved = await context.text(session.path);
	expect(saved).toContain('note: mine');
	expect(saved).toContain('stage: usable');
});

test('a word deleted elsewhere is a conflict: Keep mine creates it again from the draft', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	await context.deleteElsewhere(session.path);
	entries.inputNote(entry.id, 'still mine');
	const state = await session.settled();
	expect(
		state.status === 'error' &&
			state.error.name === 'Conflict' &&
			state.error.actualSha256,
	).toBeUndefined();
	// A deleted file is never recreated by a save.
	expect(await context.text(session.path)).toBeUndefined();

	expect(await entries.keepMine(session)).toBeUndefined();
	expect(await context.text(session.path)).toContain('note: still mine');
	expect(session.state.status).toBe('saved');
	expect(summary(entries)).toEqual([
		{ text: 'lucid', note: 'still mine', stage: 'new' },
	]);
});

test('a word deleted elsewhere: Discard closes it without writing', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	await context.deleteElsewhere(session.path);
	entries.inputNote(entry.id, 'mine');
	await session.settled();
	expect(await entries.reloadTheirs(session)).toBeUndefined();
	expect(entries.opened).toBeUndefined();
	expect(entries.entries).toEqual([]);
	// The closed session takes nothing more.
	session.edit((row) => {
		row.fields.note = 'late';
	});
	await session.settled();
	expect(await context.text(session.path)).toBeUndefined();
});

// ============================================================================
// Repair as text
// ============================================================================

test('a file that is not a valid word is named for repair, opens as text, saves as typed, and reopens as a word', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	const path = 'entries/broken.md';
	const broken =
		'---\ntext: lucid\nnote: ""\nstage: mastered\ncreatedAt: 2026-10-03T00:00:00.000Z\n---\n';
	expectOk(await folder.files.create(path, broken));
	expectOk(
		await folder.files.create('entries/unparsed.md', 'no frontmatter\n'),
	);
	await entries.refresh();
	expect(entries.entries).toEqual([]);
	expect(entries.repairs.map(({ path, stem }) => ({ path, stem }))).toEqual([
		{ path, stem: 'broken' },
		{ path: 'entries/unparsed.md', stem: 'unparsed' },
	]);
	expect(entries.repairs.every((repair) => repair.reason.length > 0)).toBe(
		true,
	);

	expect((await entries.open('broken')).kind).toBe('done');
	const session = textSession(entries);
	expect(session.draft).toBe(broken);
	session.input(broken.replace('mastered', 'usabl'));
	expect((await session.settled()).status).toBe('saved');
	// Text that is still not a word saves exactly as typed.
	expect(await context.text(path)).toBe(broken.replace('mastered', 'usabl'));
	session.input(broken.replace('mastered', 'usable'));
	await session.settled();

	expect((await entries.open('broken')).kind).toBe('done');
	expect(wordSession(entries).draft.fields).toMatchObject({
		text: 'lucid',
		stage: 'usable',
	});
	await entries.refresh();
	expect(entries.repairs.map((repair) => repair.path)).toEqual([
		'entries/unparsed.md',
	]);
	expect(summary(entries)).toEqual([
		{ text: 'lucid', note: '', stage: 'usable' },
	]);
});

test('Reload theirs of a word made invalid elsewhere opens its text', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	await context.writeElsewhere(session.path, '---\ntext: [unclosed\n---\n');
	entries.inputNote(entry.id, 'mine');
	await session.settled();
	expect(await entries.reloadTheirs(session)).toBeUndefined();
	expect(textSession(entries).draft).toBe('---\ntext: [unclosed\n---\n');
});

// ============================================================================
// Leaving, returning, stage presses, and deleting
// ============================================================================

test('opening another word waits for saves, and a failed save answers unsaved until discarded', async () => {
	await using context = await setup();
	const { entries } = context;
	expectOk(await entries.add('candid'));
	const { entry, session } = await openWord(entries, 'lucid');
	context.failNextWrite(session.path);
	entries.inputNote(entry.id, 'lost');
	const other = listed(entries, 'candid');
	expect(await entries.open(other.id)).toEqual({ kind: 'unsaved', session });
	expect(entries.opened?.id).toBe(entry.id);
	expect(await entries.open(other.id, { discard: session })).toEqual({
		kind: 'done',
		left: true,
	});
	expect(entries.opened?.id).toBe(other.id);
	expect(session.locked).toBe(true);
	expect(await context.text(entry.stored.path)).not.toContain('lost');
});

test('opening the word already open does nothing and keeps its session', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	context.failNextWrite(session.path);
	entries.inputNote(entry.id, 'unsaved');
	await session.settled();
	// Even with a failed save, opening the shown word asks nothing.
	expect(await entries.open(entry.id)).toEqual({ kind: 'done', left: false });
	expect(wordSession(entries)).toBe(session);
	expect(session.locked).toBe(false);
});

test('a discard after Reload theirs opened the word as text applies to the session the answer named', async () => {
	await using context = await setup();
	const { entries } = context;
	expectOk(await entries.add('candid'));
	const { entry, session } = await openWord(entries, 'lucid');
	const invalid = '---\ntext: [unclosed\n---\n';
	await context.writeElsewhere(session.path, invalid);
	entries.inputNote(entry.id, 'mine');
	await session.settled();
	expect(await entries.reloadTheirs(session)).toBeUndefined();
	const text = textSession(entries);
	context.failNextWrite(text.path);
	text.input(`${invalid}more`);
	await text.settled();

	const other = listed(entries, 'candid').id;
	expect(await entries.open(other)).toEqual({ kind: 'unsaved', session: text });
	// The session from before the swap discards nothing.
	expect((await entries.open(other, { discard: session })).kind).toBe(
		'unsaved',
	);
	expect(entries.opened?.id).toBe(entry.id);
	expect((await entries.open(other, { discard: text })).kind).toBe('done');
	expect(entries.opened?.id).toBe(other);
	expect(await context.text(entry.stored.path)).toBe(invalid);
});

test('returning adopts a newer version of an open word that holds nothing unsaved, and leaves a failed draft as it is', async () => {
	await using context = await setup();
	const { entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	await context.writeElsewhere(session.path, wordText('lucid', 'usable'));
	await entries.check();
	expect(session.draft.fields).toMatchObject({
		note: 'theirs',
		stage: 'usable',
	});

	context.failNextWrite(session.path);
	entries.inputNote(entry.id, 'mine');
	await session.settled();
	await context.writeElsewhere(session.path, wordText('lucid', 'understood'));
	await entries.check();
	expect(session.draft.fields.note).toBe('mine');
});

test('a stage on the open word is an edit to its draft; on a closed word it is guarded by the version the list read', async () => {
	await using context = await setup();
	const { entries } = context;
	expectOk(await entries.add('candid'));
	const { entry, session } = await openWord(entries, 'lucid');
	expect(await entries.setStage(entry, 'recognized')).toBeUndefined();
	expect(session.draft.fields.stage).toBe('recognized');
	await session.settled();

	const candid = listed(entries, 'candid');
	expect(await entries.setStage(candid, 'usable')).toBeUndefined();
	expect(listed(entries, 'candid').stage).toBe('usable');
	// The version `candid` was read at is gone now: the press is refused.
	expect(await entries.setStage(candid, 'new')).toContain('changed elsewhere');
	expect(listed(entries, 'candid').stage).toBe('usable');
});

test('deleting the open word waits for its saves and removes what they saved', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	const { held, release } = context.holdNextWrite();
	entries.inputNote(entry.id, 'typed before delete');
	await held;
	const removing = entries.remove(entry);
	// Input stops at once.
	expect(session.locked).toBe(true);
	release();
	expect(await removing).toBeUndefined();
	expect(entries.opened).toBeUndefined();
	expect(entries.entries).toEqual([]);
	expect(await tableFiles(folder, 'entries')).toEqual([]);
});

test('a delete is refused when the word changed elsewhere, and the word opens again as it is now', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	const { entry, session } = await openWord(entries, 'lucid');
	await context.writeElsewhere(session.path, wordText('lucid', 'usable'));
	expect(await entries.remove(entry)).toContain('changed elsewhere');
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
	expect(wordSession(entries).draft.fields.stage).toBe('usable');
});

test('a closed word is deleted only as the list showed it', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	expectOk(await entries.add('lucid'));
	const entry = listed(entries, 'lucid');
	await context.writeElsewhere(entry.stored.path, wordText('lucid', 'usable'));
	expect(await entries.remove(entry)).toContain('changed elsewhere');
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
	expect(await entries.remove(listed(entries, 'lucid'))).toBeUndefined();
	expect(await tableFiles(folder, 'entries')).toEqual([]);
});

test('a closed folder answers with an error and lists nothing new', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	expectOk(await entries.add('in hindsight'));
	await folder.close();
	expect(expectErr(await entries.add('on the fence')).name).toBe('NotSaved');
	await entries.refresh();
	expect(entries.loadError).not.toBeNull();
	expect(summary(entries)).toEqual([
		{ text: 'in hindsight', note: '', stage: 'new' },
	]);
});

test('a stage pressed on a word that is still opening saves it as listed', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	expectOk(await entries.add('lucid'));
	const entry = listed(entries, 'lucid');
	// The same folder, with opening a word held until `reading` resolves.
	const reading = Promise.withResolvers<void>();
	const real = folder.tables.entries;
	const opening = createEntriesState({
		table: {
			...real,
			async get(stem) {
				await reading.promise;
				return real.get(stem);
			},
		},
		files: folder.files,
	});
	await opening.refresh();
	const pending = opening.open(entry.id);
	await Bun.sleep(0);
	expect(opening.opened?.kind).toBe('loading');
	expect(await opening.setStage(entry, 'usable')).toBeUndefined();
	expect(await context.text(entry.stored.path)).toContain('stage: usable');
	reading.resolve();
	await pending;
	expect(wordSession(opening).draft.fields.stage).toBe('usable');
	await opening.close();
});

test('the list read after leaving a word lands, even when a word is added meanwhile', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, table } = gated(folder.tables.entries);
	const entries = createEntriesState({ table, files: folder.files });
	expectOk(await entries.add('candid'));
	const { entry, session } = await openWord(entries, 'lucid');
	entries.inputNote(entry.id, 'clear');
	await session.settled();
	// The relist that leaving starts reads now and answers late.
	const delivery = Promise.withResolvers<void>();
	gate.heldListing = delivery.promise;
	expect((await entries.open(listed(entries, 'candid').id)).kind).toBe('done');
	gate.heldListing = undefined;
	expectOk(await entries.add('subtle'));
	delivery.resolve();
	for (let i = 0; i < 200 && listed(entries, 'lucid').note !== 'clear'; i++)
		await Bun.sleep(1);
	expect(listed(entries, 'lucid').note).toBe('clear');
	// The word added while the listing was out is still listed.
	expect(entries.entries.map((e) => e.text).sort()).toEqual([
		'candid',
		'lucid',
		'subtle',
	]);
	// A stage pressed from the list uses what was saved.
	expect(
		await entries.setStage(listed(entries, 'lucid'), 'usable'),
	).toBeUndefined();
	await entries.close();
});

test('close waits for a change already under way, and refuses one asked after it began', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	expectOk(await entries.add('lucid'));
	const entry = listed(entries, 'lucid');
	const { held, release } = context.holdNextWrite();
	const pressing = entries.setStage(entry, 'usable');
	await held;
	expect(entries.unsaved).toBe(true);
	let closed = false;
	const closing = entries.close().then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	expect(await entries.remove(entry)).toContain('closing');
	release();
	expect(await pressing).toBeUndefined();
	await closing;
	expect(await fileText(folder, entry.stored.path)).toContain('stage: usable');
});
