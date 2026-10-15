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
 * - An edit changes the cache at once and is written to the file
 * - Rapid edits run one write at a time with one waiting; the waiting write
 *   saves the newest word, guarded by the hash the previous write confirmed
 * - No read starts while a write runs
 * - A write that meets a change made elsewhere merges with it, and the edit
 *   wins only where both changed
 * - A write that fails rolls the cache back to the file and reports the
 *   text that was lost
 * - A file that is not a valid word is named for repair, written as typed
 *   text, and reads as a word once repaired
 * - Delete runs after the word's queued writes and removes what they saved;
 *   a file changed elsewhere since is refused
 * - Nothing commits on its own after edits
 * - Close waits for every write and action, and afterwards nothing changes
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { VocabFolder } from './data.js';
import {
	createBrowser,
	fileText,
	gated,
	tableFiles,
} from './folder.test-support.js';
import type { WriteFailure } from './query.js';
import {
	cached,
	createQueryClient,
	focusManager,
	listing,
	observe,
	quiet,
} from './query.test-support.js';
import type { Vocab } from './vocab.svelte.js';

const { createVocab } = await import('./vocab.svelte.ts');
const { repairsOf, wordsOf } = await import('./entries.svelte.ts');
const { vocabKeys } = await import('./query.ts');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** Vocab over `folder`, with its screens observing, read once. */
async function openVocab(folder: VocabFolder) {
	const failures: WriteFailure[] = [];
	const vocab = createVocab(folder, createQueryClient(), {
		onWriteFailed: (failure) => failures.push(failure),
	});
	cleanup.push(() => vocab.close());
	cleanup.push(observe(vocab));
	await quiet(vocab);
	return { vocab, failures };
}

/**
 * Vocab over a fresh browser folder. `holdNextWrite` holds the next write of
 * a word file until released, and `wordWrites` counts every one.
 */
async function setup() {
	const browser = createBrowser();
	cleanup.push(() => browser[Symbol.asyncDispose]());
	const folder = await browser.open();
	const { vocab, failures } = await openVocab(folder);
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
		/** Another program writes the file. */
		async writeElsewhere(path: string, content: string) {
			expectOk(await folder.files.overwrite(path, content));
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
	entries.inputNote(entry.id, 'mostly');
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
// Edits and writes
// ============================================================================

test('an edit changes the cache at once and is written to the file', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	expect(entries.inputNote(entry.id, 'clear')).toBe(true);
	expect(cached(vocab, 'lucid').note).toBe('clear');
	await quiet(vocab);
	expect(failures).toEqual([]);
	expect(await context.text(entry.stored.path)).toContain('note: clear');
	expect(cached(vocab, 'lucid').stored.sha256).toBe(
		await context.sha(entry.stored.path),
	);
});

test('rapid edits run one write at a time with one waiting, which saves the newest word with no conflict', async () => {
	const context = await setup();
	const { vocab, entries, failures, counter } = context;
	const entry = await context.add('lucid');
	const path = entry.stored.path;
	const before = counter.wordWrites;

	const { held, release } = context.holdNextWrite();
	entries.inputNote(entry.id, 'c');
	await held;
	for (const note of ['cl', 'cle', 'clea', 'clear'])
		entries.inputNote(entry.id, note);
	entries.setStage(entry.id, 'understood');
	// One write runs and one waits; no more were queued.
	expect(
		vocab.queryClient.isMutating({ mutationKey: vocabKeys.write(path) }),
	).toBe(2);
	expect(cached(vocab, 'lucid')).toMatchObject({
		note: 'clear',
		stage: 'understood',
	});

	release();
	await quiet(vocab);
	expect(failures).toEqual([]);
	expect(counter.wordWrites - before).toBe(2);
	const saved = await context.text(path);
	expect(saved).toContain('note: clear');
	expect(saved).toContain('stage: understood');
	expect(cached(vocab, 'lucid').stored.sha256).toBe(await context.sha(path));

	// The guard moved forward: the next edit writes on top.
	entries.inputNote(entry.id, 'clear, two');
	await quiet(vocab);
	expect(failures).toEqual([]);
	expect(await context.text(path)).toContain('note: clear, two');
});

test('no read starts while a write runs: not on returning to the window, not when a view mounts', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	const path = entry.stored.path;

	const { held, release } = context.holdNextWrite();
	entries.inputNote(entry.id, 'clear');
	await held;
	// Returning to the window while the write is held reads nothing.
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	// The client refetches on focus a tick later, after resuming paused writes.
	await Bun.sleep(0);
	// Neither does a view that mounts now.
	const mounted = observe(vocab);
	expect(vocab.queryClient.isFetching({ queryKey: vocabKeys.entries })).toBe(0);
	expect(cached(vocab, 'lucid').note).toBe('clear');
	release();
	await quiet(vocab);
	mounted();
	expect(cached(vocab, 'lucid').note).toBe('clear');
	expect(cached(vocab, 'lucid').stored.sha256).toBe(await context.sha(path));

	entries.inputNote(entry.id, 'clear, two');
	await quiet(vocab);
	expect(failures).toEqual([]);
	expect(await context.text(path)).toContain('note: clear, two');
});

test('a write that meets a change made elsewhere merges with it: the edit wins only where both changed', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	const path = entry.stored.path;
	await context.writeElsewhere(path, wordText('lucid', 'theirs', 'usable'));

	entries.inputNote(entry.id, 'mine');
	await quiet(vocab);
	expect(failures).toEqual([]);
	// Both changed the note, so the edit's stands; only they changed the stage.
	expect(await context.text(path)).toContain('note: mine');
	expect(await context.text(path)).toContain('stage: usable');
});

test('a write that fails rolls back, and the write waiting behind it leaves the file as it was', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	const path = entry.stored.path;
	const saved = await context.text(path);

	context.failNextWrite(path);
	entries.inputNote(entry.id, 'first');
	entries.inputNote(entry.id, 'second');
	expect(
		vocab.queryClient.isMutating({ mutationKey: vocabKeys.write(path) }),
	).toBe(2);
	await quiet(vocab);
	// The rollback lands before the waiting write runs, so it saves the
	// file's own word and fails nothing.
	expect(failures.map((failure) => failure.lost)).toEqual([
		expect.stringContaining('note: second'),
	]);
	expect(await context.text(path)).toBe(saved);
	expect(cached(vocab, 'lucid').note).toBe('');
});

test('the folder refuses a value it cannot hold, and the cache rolls back', async () => {
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
	entries.inputNote(entry.id, 'a\uD800b');
	expect(cached(vocab, 'lucid').note).toBe('a�b');
	await quiet(vocab);
	expect((await context.reopened())[0]?.note).toBe('a�b');
});

test('nothing commits on its own after edits', async () => {
	const context = await setup();
	const { folder, vocab, entries } = context;
	const entry = await context.add('lucid');
	entries.inputNote(entry.id, 'clear');
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
	await vocab.queryClient.invalidateQueries({ queryKey: vocabKeys.all });
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
	await quiet(vocab);
	expect(await context.text(path)).toBe(half);
	expect(repairsOf(listing(vocab))).toHaveLength(1);

	const whole = wordText('lucid', 'fixed', 'new');
	entries.inputText(path, whole);
	await quiet(vocab);
	entries.closeRepair();
	await quiet(vocab);
	expect(failures).toEqual([]);
	expect(repairsOf(listing(vocab))).toEqual([]);
	expect(cached(vocab, 'lucid')).toMatchObject({ note: 'fixed', stage: 'new' });
});

// ============================================================================
// Delete
// ============================================================================

test('a delete runs after the queued writes and removes what they saved; edits wait while it runs', async () => {
	const context = await setup();
	const { vocab, entries, failures } = context;
	const entry = await context.add('lucid');
	const path = entry.stored.path;
	const { held, release } = context.holdNextWrite();
	entries.inputNote(entry.id, 'typed while asked');
	await held;
	const removing = entries.remove(entry);
	await Bun.sleep(5);
	expect(entries.isLocked(entry.id)).toBe(true);
	expect(entries.inputNote(entry.id, 'typed during the delete')).toBe(false);
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

test('close waits for running writes, and every close call shares one completion', async () => {
	const context = await setup();
	const { folder, vocab, entries } = context;
	const entry = await context.add('lucid');
	const { held, release } = context.holdNextWrite();
	entries.inputNote(entry.id, 'clear');
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
	const writes = vocab.queryClient
		.getMutationCache()
		.findAll({ mutationKey: vocabKeys.write(entry.stored.path) });
	expect(writes.map((write) => write.state.status)).toEqual(['success']);
});

test('after close begins, edits and actions change nothing', async () => {
	const context = await setup();
	const { vocab, entries } = context;
	const entry = await context.add('lucid');
	const saved = await context.text(entry.stored.path);
	void vocab.close();
	expect(entries.inputNote(entry.id, 'late')).toBe(false);
	expect(cached(vocab, 'lucid').note).toBe('');
	expect(expectErr(await entries.add('another')).name).toBe('NotStarted');
	expect(expectErr(await entries.remove(entry)).name).toBe('NotStarted');
	expect(saved).toContain('note: ""');
});
