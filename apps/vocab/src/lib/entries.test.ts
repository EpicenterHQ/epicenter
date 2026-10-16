/**
 * Saved word tests.
 * The real Vocab owner and its TanStack Query cache run over Vocab's real
 * browser folder on an in-memory OPFS stand-in. Screens are stood in for as
 * they behave: they observe the queries they show. "Saved" is read back from
 * the file, and from the folder opened again, never assumed from the cache.
 *
 * Key behaviors:
 * - A word is listed once its file exists, with a blank note and the New
 *   stage; one exact text is one file, whoever adds it and however often
 * - A note or a stage is an update written to the file; the list takes the
 *   saved version
 * - One word's updates run one at a time, in the order made, so a stage
 *   press never undoes a note
 * - Another tab's change reaches the list through the folder's change channel
 * - An update over a change made elsewhere keeps the fields it did not set
 *   and wins the one it set, with nothing to report
 * - An update that fails is reported and writes nothing; the next one writes
 * - A file that is not a valid word is named for repair, written as typed
 *   text, and reads as a word once repaired
 * - Delete waits for the word's save under way and removes what it saved;
 *   a file changed elsewhere since is refused
 * - Nothing commits on its own after edits
 * - Close waits for every write and action, and afterwards nothing changes
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { VocabFolder } from './data.js';
import type { ReplacedNotice } from './entries.svelte.js';
import {
	createBrowser,
	fileText,
	gated,
	tableFiles,
	until,
} from './folder.test-support.js';
import type { WriteFailure } from './query.js';
import {
	cached,
	createQueryClient,
	listing,
	observe,
	quiet,
} from './query.test-support.js';
import type { Vocab } from './vocab.svelte.js';

const { createVocab } = await import('./vocab.svelte.ts');
const { repairsOf, wordsOf } = await import('./entries.svelte.ts');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** Vocab over `folder`, with its screens observing, read once. */
async function openVocab(folder: VocabFolder) {
	const failures: WriteFailure[] = [];
	const replaced: ReplacedNotice[] = [];
	const vocab = createVocab(folder, createQueryClient(), {
		onWriteFailed: (failure) => failures.push(failure),
		onReplaced: (notice) => replaced.push(notice),
	});
	cleanup.push(() => vocab.close());
	cleanup.push(observe(vocab));
	await quiet(vocab);
	return { vocab, failures, replaced };
}

/**
 * Vocab over a fresh browser folder. `holdNextWrite` holds the next write of
 * a word file until released, and `wordWrites` counts every one.
 */
async function setup() {
	const browser = createBrowser();
	cleanup.push(() => browser[Symbol.asyncDispose]());
	const folder = await browser.open();
	const { vocab, failures, replaced } = await openVocab(folder);
	const { faults } = browser.opfs;
	const counter = { wordWrites: 0 };
	let hold: PromiseWithResolvers<void> | undefined;
	let held: PromiseWithResolvers<void> | undefined;
	// Every stream opened under `entries/` is one write of a word file.
	faults.open = async (path) => {
		if (!path.includes('/entries/')) return;
		counter.wordWrites++;
		const gate = hold;
		if (gate === undefined) return;
		hold = undefined;
		held?.resolve();
		await gate.promise;
	};
	return {
		browser,
		folder,
		vocab,
		entries: vocab.entries,
		failures,
		replaced,
		counter,
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
		text: (path: string) => fileText(folder, path),
		async sha(path: string) {
			return expectOk(await folder.files.read(path)).sha256;
		},
		/** Another program writes the file over whatever is there. */
		async writeElsewhere(path: string, content: string) {
			const current = await folder.files.read(path);
			if (current.error?.name === 'NotFound')
				return void expectOk(await folder.files.create(path, content));
			expectOk(
				await folder.files.save(expectOk(current), content, { merge: false }),
			);
		},
		/** The words a reload would list, from the folder opened again. */
		async reopened() {
			const again = await openVocab(await browser.open());
			return words(again.vocab);
		},
		/** Add `text` through the app and wait for the list to read it. */
		async add(text: string) {
			expectOk(await vocab.entries.add(text));
			await quiet(vocab);
			return cached(vocab, text);
		},
	};
}

const words = (vocab: Vocab) =>
	wordsOf(listing(vocab)).map(({ text, note, stage }) => ({
		text,
		note,
		stage,
	}));

const wordText = (text: string, note = 'theirs', stage = 'new') =>
	`---\ntext: ${text}\nnote: ${note}\nstage: ${stage}\ncreatedAt: 2026-10-03T00:00:00.000Z\n---\n`;

// ============================================================================
// Adding words
// ============================================================================

test('a word is listed once its file exists, with a blank note and the New stage, and is there after reopening', async () => {
	const context = await setup();
	const { folder, vocab, entries } = context;
	const adding = entries.add('  lucid  ');
	expect(words(vocab)).toEqual([]);
	expect(expectOk(await adding)).toBe('added');
	expect(words(vocab)).toEqual([{ text: 'lucid', note: '', stage: 'new' }]);
	expect(await tableFiles(folder, 'entries')).toEqual([
		cached(vocab, 'lucid').stored.path,
	]);
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: '', stage: 'new' },
	]);
});

test('text is trimmed and otherwise exact in any script or spelling', async () => {
	const context = await setup();
	const { vocab, entries } = context;
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
	expect(
		words(vocab)
			.map((entry) => entry.text)
			.sort(),
	).toEqual(sorted);
	expect((await context.reopened()).map((entry) => entry.text).sort()).toEqual(
		sorted,
	);
});

test('a phrase with the exact text of a saved word writes nothing and leaves its note and stage alone', async () => {
	const context = await setup();
	const { folder, vocab, entries } = context;
	const entry = await context.add('by and large');
	entries.setNote(entry.id, 'mostly');
	entries.setStage(entry.id, 'understood');
	await quiet(vocab);
	const before = await context.text(entry.stored.path);
	expect(before).toContain('note: mostly');

	expect(expectOk(await entries.add(' by and large '))).toBe('present');
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
	expect(await context.text(entry.stored.path)).toBe(before);
});

test('adds of one text made together, in one tab or two, save one word', async () => {
	const context = await setup();
	const { browser, folder, vocab, entries } = context;
	const otherTab = await openVocab(await browser.open());
	const outcomes = await Promise.all([
		entries.add('on the fence'),
		entries.add(' on the fence '),
		otherTab.vocab.entries.add('on the fence'),
	]);
	expect(outcomes.map((outcome) => expectOk(outcome)).sort()).toEqual([
		'added',
		'present',
		'present',
	]);
	await quiet(otherTab.vocab);
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
	expect(words(otherTab.vocab)).toEqual([
		{ text: 'on the fence', note: '', stage: 'new' },
	]);
	// A different text, however close, is another word.
	expect(expectOk(await entries.add('On the fence'))).toBe('added');
	await quiet(vocab);
	expect(await tableFiles(folder, 'entries')).toHaveLength(2);
});

test('a refused add lists nothing; an add that landed without its answer is found by the retry', async () => {
	const context = await setup();
	const { folder } = context;
	const { gate, table } = gated(folder.tables.entries);
	const { vocab } = await openVocab({
		...folder,
		tables: { ...folder.tables, entries: table },
	} as VocabFolder);

	gate.failing = true;
	expect(expectErr(await vocab.entries.add('subtle')).name).toBe('NotSaved');
	expect(await tableFiles(folder, 'entries')).toEqual([]);
	gate.failing = false;

	gate.losingReceipt = true;
	expect(expectErr(await vocab.entries.add('subtle')).name).toBe('NotSaved');
	const files = await tableFiles(folder, 'entries');
	expect(files).toHaveLength(1);
	expect(expectOk(await vocab.entries.add('subtle'))).toBe('present');
	await quiet(vocab);
	expect(await tableFiles(folder, 'entries')).toEqual(files);
	expect(words(vocab)).toEqual([{ text: 'subtle', note: '', stage: 'new' }]);
});

test('a different file where a new word belongs is refused and left as it is', async () => {
	const context = await setup();
	const { entries } = context;
	const path = (await context.add('lucid')).stored.path;
	const other = wordText('lurid');
	await context.writeElsewhere(path, other);
	expect(expectErr(await entries.add('lucid')).name).toBe('Taken');
	expect(await context.text(path)).toBe(other);
});

test('a word another tab removed is saved again instead of being called present', async () => {
	const context = await setup();
	const { browser, folder, entries } = context;
	await context.add('resilient');
	const otherTab = await openVocab(await browser.open());
	expectOk(
		await otherTab.vocab.entries.remove(cached(otherTab.vocab, 'resilient')),
	);
	expect(expectOk(await entries.add('resilient'))).toBe('added');
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
});

// ============================================================================
// Edits and saves
// ============================================================================

test('a note is written to the file; the list takes the saved version', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	expect(entries.setNote(entry.id, 'clear')).toBe(true);
	await quiet(vocab);
	expect(failures).toEqual([]);
	expect(await context.text(entry.stored.path)).toContain('note: clear');
	expect(cached(vocab, 'lucid')).toMatchObject({ note: 'clear' });
	expect(cached(vocab, 'lucid').stored.sha256).toBe(
		await context.sha(entry.stored.path),
	);
});

test("one word's updates run one at a time in the order made, so a stage press does not undo a note", async () => {
	const context = await setup();
	const { vocab, entries, failures, counter } = context;
	const entry = await context.add('lucid');
	const path = entry.stored.path;
	const before = counter.wordWrites;

	const { held, release } = context.holdNextWrite();
	entries.setNote(entry.id, 'clear');
	await held;
	entries.setStage(entry.id, 'understood');
	// The stage waits for the note to land.
	expect(counter.wordWrites - before).toBe(1);

	release();
	await quiet(vocab);
	expect(failures).toEqual([]);
	expect(context.replaced).toEqual([]);
	expect(counter.wordWrites - before).toBe(2);
	const saved = await context.text(path);
	expect(saved).toContain('note: clear');
	expect(saved).toContain('stage: understood');
	expect(cached(vocab, 'lucid').stored.sha256).toBe(await context.sha(path));
});

test("another tab's edit reaches this page's list through the folder's change channel", async () => {
	const browser = createBrowser({ BroadcastChannel });
	cleanup.push(() => browser[Symbol.asyncDispose]());
	const here = await openVocab(await browser.open());
	const there = await openVocab(await browser.open());
	expectOk(await there.vocab.entries.add('lucid'));
	await until(() => {
		try {
			return cached(here.vocab, 'lucid') !== undefined;
		} catch {
			return false;
		}
	}, 'the added word');

	there.vocab.entries.setNote(cached(there.vocab, 'lucid').id, 'theirs');
	await quiet(there.vocab);
	await until(
		() => cached(here.vocab, 'lucid').note === 'theirs',
		"the other tab's note",
	);
});

test('an update over a change made elsewhere keeps their other fields and wins the one it set', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	const path = entry.stored.path;
	await context.writeElsewhere(path, wordText('lucid', 'theirs', 'usable'));

	entries.setNote(entry.id, 'mine');
	await quiet(vocab);
	expect(failures).toEqual([]);
	// The note is the learner's; only they changed the stage, so it stays.
	expect(await context.text(path)).toContain('note: mine');
	expect(await context.text(path)).toContain('stage: usable');
	// An update replaces only what it names, so there is nothing to report.
	expect(context.replaced).toEqual([]);
	expect(cached(vocab, 'lucid')).toMatchObject({
		note: 'mine',
		stage: 'usable',
	});
});

test('an update that fails is reported and writes nothing; the next one writes', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	const path = entry.stored.path;
	const saved = await context.text(path);

	context.failNextWrite(path);
	entries.setNote(entry.id, 'kept');
	await quiet(vocab);
	expect(failures.map((failure) => failure.path)).toEqual([path]);
	expect(await context.text(path)).toBe(saved);
	expect(cached(vocab, 'lucid').note).toBe('');

	entries.setNote(entry.id, 'kept');
	await quiet(vocab);
	expect(failures).toHaveLength(1);
	expect(await context.text(path)).toContain('note: kept');
	expect(cached(vocab, 'lucid').note).toBe('kept');
});

test('the folder refuses a value it cannot hold, and the file is left as it was', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	const saved = await context.text(entry.stored.path);
	// The stage buttons offer only valid stages; this bypasses them.
	entries.setStage(entry.id, 'mastered' as 'new');
	await quiet(vocab);
	expect(failures).toMatchObject([
		{ path: entry.stored.path, error: { name: 'InvalidValues' } },
	]);
	expect(await context.text(entry.stored.path)).toBe(saved);
	expect(cached(vocab, 'lucid').stage).toBe('new');
});

test('a note is kept well formed, so what saves is what is shown', async () => {
	const context = await setup();
	const { vocab, entries } = context;
	const entry = await context.add('lucid');
	entries.setNote(entry.id, 'a\uD800b');
	await quiet(vocab);
	expect(cached(vocab, 'lucid').note).toBe('a�b');
	expect((await context.reopened())[0]?.note).toBe('a�b');
});

test('nothing commits on its own after edits', async () => {
	const context = await setup();
	const { folder, vocab, entries } = context;
	const entry = await context.add('lucid');
	entries.setNote(entry.id, 'clear');
	entries.setStage(entry.id, 'usable');
	await quiet(vocab);
	await Bun.sleep(50);
	expect(folder.git.snapshot.lastCommit).toBeUndefined();
	const status = expectOk(await folder.git.status());
	expect(status.changes.map((change) => change.path)).toContain(
		entry.stored.path,
	);
});

// ============================================================================
// Words that need repair
// ============================================================================

test('a file that is not a valid word is named for repair, is written as typed text, and reads as a word once repaired', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const path = (await context.add('lucid')).stored.path;
	await context.writeElsewhere(path, '---\ntext: lucid\nnote: *bad\n---\n');
	// As the folder reports a change another program made.
	await vocab.queryClient.invalidateQueries(vocab.folder$.pathFilter([path]));
	await quiet(vocab);
	expect(wordsOf(listing(vocab))).toEqual([]);
	expect(repairsOf(listing(vocab))).toEqual([
		{ path, reason: expect.any(String), stem: expect.any(String) },
	]);
	expect(entries.isLocked(path.slice('entries/'.length, -3))).toBe(false);

	entries.openRepair(path);
	cleanup.push(observe(vocab, path));
	await quiet(vocab);
	// Text that still does not parse is written as typed.
	const half = '---\ntext: lucid\nnote: fixed\nstage: soon\n---\n';
	expect(entries.inputText(path, half)).toBe(true);
	expect(entries.repairText).toBe(half);
	// The card writes it once the person pauses.
	void entries.saveRepair();
	await quiet(vocab);
	expect(await context.text(path)).toBe(half);
	expect(repairsOf(listing(vocab))).toHaveLength(1);

	const whole = wordText('lucid', 'fixed', 'new');
	entries.inputText(path, whole);
	expect(await entries.closeRepair()).toBe(true);
	await quiet(vocab);
	expect(failures).toEqual([]);
	expect(await context.text(path)).toBe(whole);
	expect(entries.repairing).toBeUndefined();
	expect(repairsOf(listing(vocab))).toEqual([]);
	expect(cached(vocab, 'lucid')).toMatchObject({ note: 'fixed', stage: 'new' });
});

// ============================================================================
// Delete
// ============================================================================

test('a delete waits for the update under way and removes what it saved; edits wait while it runs', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	const path = entry.stored.path;
	const { held, release } = context.holdNextWrite();
	entries.setNote(entry.id, 'typed while asked');
	await held;
	const removing = entries.remove(entry);
	await Bun.sleep(5);
	expect(entries.isLocked(entry.id)).toBe(true);
	expect(entries.setNote(entry.id, 'typed during the delete')).toBe(false);
	release();
	expectOk(await removing);
	await quiet(vocab);
	expect(failures).toEqual([]);
	expect(await context.text(path)).toBeUndefined();
	expect(wordsOf(listing(vocab))).toEqual([]);
});

test('a delete is refused when the word changed elsewhere, and the list reads it again', async () => {
	const context = await setup();
	const { vocab, entries } = context;
	const entry = await context.add('lucid');
	const elsewhere = wordText('lucid', 'theirs', 'usable');
	await context.writeElsewhere(entry.stored.path, elsewhere);
	expect(expectErr(await entries.remove(entry)).name).toBe('Conflict');
	await quiet(vocab);
	expect(await context.text(entry.stored.path)).toBe(elsewhere);
	expect(cached(vocab, 'lucid').note).toBe('theirs');
});

// ============================================================================
// Closing
// ============================================================================

test('close waits for running saves, and every close call shares one completion', async () => {
	const context = await setup();
	const { folder, vocab, entries } = context;
	const entry = await context.add('lucid');
	const { held, release } = context.holdNextWrite();
	entries.setNote(entry.id, 'clear');
	await held;
	let closed = false;
	const first = vocab.close();
	expect(vocab.close()).toBe(first);
	void first.then(() => {
		closed = true;
	});
	await Bun.sleep(10);
	expect(closed).toBe(false);
	release();
	await first;
	expect(folder.signal.aborted).toBe(true);
	const saves = vocab.queryClient.getMutationCache().findAll({
		mutationKey: vocab.folder$.entries.update.mutationOptions().mutationKey,
	});
	expect(saves.map((save) => save.state.status)).toEqual(['success']);
});

test('after close begins, edits and actions change nothing', async () => {
	const context = await setup();
	const { vocab, entries } = context;
	const entry = await context.add('lucid');
	const saved = await context.text(entry.stored.path);
	void vocab.close();
	expect(entries.setNote(entry.id, 'late')).toBe(false);
	expect(expectErr(await entries.add('another')).name).toBe('NotStarted');
	expect(expectErr(await entries.remove(entry)).name).toBe('NotStarted');
	expect(saved).toContain('note: ""');
});
