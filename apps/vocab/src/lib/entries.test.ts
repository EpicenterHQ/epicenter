/**
 * Saved word tests.
 * The real Vocab store runs over the local folder context
 * (`createFolderContext`) on Vocab's real local folder over an
 * in-memory IndexedDB. Screens are stood in for as they behave: they observe
 * the queries they show. "Saved" is read back from the file, and from the
 * folder opened again, never assumed from the cache.
 *
 * Key behaviors:
 * - A word is listed once its file exists, with a blank note and the New
 *   stage; one exact text is one file, whoever adds it and however often
 * - A note is held as typed, over any reread, and saved after a pause; a
 *   stage press saves at once and keeps the note typed meanwhile
 * - Another tab's save reaches the list through the folder's change channel,
 *   and a save over it keeps the fields it did not set
 * - A save that fails keeps the typing and its error; saving again writes it
 * - Fields the schema does not name, and the body, survive a save
 * - A file that is not a valid word is named for repair, written as typed
 *   text, and reads as a word once repaired
 * - Delete waits for the typing to save; typing that failed to save is not
 *   deleted with the word
 * - Close saves typing still waiting for its pause, and refuses new input
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { SaveError } from '@epicenter/folder';
import { Err } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { VocabFolder } from './data.js';
import {
	createBrowser,
	fileText,
	put,
	tableFiles,
	until,
} from './folder.test-support.js';
import { cached, openVocab, quiet, rows } from './query.test-support.js';

const { repairsOf, wordsOf } = await import('./entries.svelte.ts');

/** The file name of the word with exact text `text`. */
const idOf = (text: string) =>
	new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** The words a folder holds, read from its files. */
async function savedWords(folder: VocabFolder) {
	return wordsOf(expectOk(await folder.tables.entries.list()));
}

/**
 * Make every save fail with a storage failure while `failing`, as a full
 * browser store answers; disposing it lets storage write again.
 */
function failSaves() {
	const put = IDBObjectStore.prototype.put;
	const control = {
		failing: true,
		[Symbol.dispose]() {
			IDBObjectStore.prototype.put = put;
		},
	};
	IDBObjectStore.prototype.put = function (
		this: IDBObjectStore,
		...args: Parameters<IDBObjectStore['put']>
	) {
		if (control.failing)
			throw new DOMException('storage refused', 'QuotaExceededError');
		return put.apply(this, args);
	};
	return control;
}

/** A browser with Vocab open over it, holding the word `lucid`. */
async function setup() {
	const browser = createBrowser();
	const folder = await browser.open();
	const opened = await openVocab(folder);
	expectOk(await opened.vocab.entries.add('lucid'));
	return {
		browser,
		folder,
		...opened,
		path: `entries/${idOf('lucid')}.md`,
		/** The word as the page shows it now. */
		word: () => cached(opened.vocab, 'lucid'),
		async [Symbol.asyncDispose]() {
			await opened[Symbol.asyncDispose]();
			await browser[Symbol.asyncDispose]();
		},
	};
}

test('a word is listed once its file exists, with a blank note and the New stage, and is there after reopening', async () => {
	await using context = await setup();
	const word = context.word();
	expect(word).toMatchObject({ id: idOf('lucid'), note: '', stage: 'new' });
	expect(await tableFiles(context.folder, 'entries')).toEqual([context.path]);
	const reopened = await context.browser.open();
	expect((await savedWords(reopened)).map((entry) => entry.text)).toEqual([
		'lucid',
	]);
});

test('text is trimmed and otherwise exact in any script, and half of a surrogate pair is saved as U+FFFD', async () => {
	await using context = await setup();
	const { entries } = context.vocab;
	for (const text of ['  顺便 \n', 'naïve café', 'Straße', 'a\uD800b'])
		expect(expectOk(await entries.add(text))).toBe('added');
	expect(expectErr(await entries.add('   ')).name).toBe('Empty');
	expect(
		(await savedWords(context.folder)).map((entry) => entry.text).sort(),
	).toEqual(['Straße', 'a�b', 'lucid', 'naïve café', '顺便'].sort());
});

test('adding the exact text of a saved word writes nothing and leaves its note and stage alone', async () => {
	await using context = await setup();
	const { entries } = context.vocab;
	expect(entries.setStage(context.word(), 'usable')).toBe(true);
	expect(entries.setNote(context.word(), 'clear')).toBe(true);
	await context.folder.tables.entries.edit(context.word().id).save();
	const saved = await fileText(context.folder, context.path);

	expect(expectOk(await entries.add(' lucid '))).toBe('present');
	expect(await tableFiles(context.folder, 'entries')).toEqual([context.path]);
	expect(await fileText(context.folder, context.path)).toBe(saved);
	expect(context.word()).toMatchObject({ note: 'clear', stage: 'usable' });
});

test('adds of one text made together, in two tabs, save one word', async () => {
	await using context = await setup();
	await using other = await openVocab(await context.browser.open());
	const [here, there] = await Promise.all([
		context.vocab.entries.add('opaque'),
		other.vocab.entries.add('opaque'),
	]);
	expectOk(here);
	expectOk(there);
	expect(await tableFiles(context.folder, 'entries')).toEqual(
		[context.path, `entries/${idOf('opaque')}.md`].sort(),
	);
	expect(
		(await savedWords(context.folder)).filter((word) => word.text === 'opaque'),
	).toHaveLength(1);
});

test('a refused add lists nothing and the retry adds it; an add that landed without its answer is found by the retry', async () => {
	await using context = await setup();
	const { entries } = context.vocab;
	using saves = failSaves();
	expect(expectErr(await entries.add('opaque')).name).toBe('NotSaved');
	expect(() => cached(context.vocab, 'opaque')).toThrow();
	expect(await tableFiles(context.folder, 'entries')).toEqual([context.path]);

	saves.failing = false;
	expect(expectOk(await entries.add('opaque'))).toBe('added');
	expect(cached(context.vocab, 'opaque').stage).toBe('new');

	// The save lands, and its answer is lost on the way back.
	const table = context.folder.tables.entries;
	const set = table.set;
	table.set = async (...args) => {
		await set(...args);
		table.set = set;
		return Err({
			name: 'StorageFailed',
			message: 'lost',
			cause: new Error('lost'),
		} as SaveError);
	};
	expect(expectErr(await entries.add('subtle')).name).toBe('NotSaved');
	expect(expectOk(await entries.add('subtle'))).toBe('present');
	expect(
		(await savedWords(context.folder)).filter((word) => word.text === 'subtle'),
	).toHaveLength(1);
});

test('a different file where a new word belongs is refused and left as it is', async () => {
	await using context = await setup();
	const path = `entries/${idOf('opaque')}.md`;
	const other = '---\ntext: lurid\nnote: ""\nstage: new\ncreatedAt: x\n---\n';
	await put(context.folder, path, other);
	expect(expectErr(await context.vocab.entries.add('opaque'))).toMatchObject({
		name: 'Taken',
		path,
	});
	expect(await fileText(context.folder, path)).toBe(other);
});

test('a note is held as typed over a reread, saved after a pause, and the list takes the saved version', async () => {
	await using context = await setup();
	const { vocab } = context;
	const edit = context.folder.tables.entries.edit(context.word().id);
	const before = await fileText(context.folder, context.path);

	expect(vocab.entries.setNote(context.word(), 'clear and bright')).toBe(true);
	expect(edit.getPending()).toBeDefined();
	expect(
		vocab.folder.getStatus().saving ||
			vocab.folder.getStatus().unsaved.length > 0,
	).toBe(true);
	// A reread of the list never replaces what is typed.
	await vocab.queryClient.invalidateQueries();
	expect(edit.getMarkdown()?.fields?.note).toBe('clear and bright');
	expect(await fileText(context.folder, context.path)).toBe(before);

	await until(() => edit.getPending() === undefined, 'the note to save');
	await quiet(vocab);
	expect(
		expectOk(await context.folder.tables.entries.get(context.word().id))?.fields?.note,
	).toBe('clear and bright');
	expect(context.word().note).toBe('clear and bright');
	expect(
		vocab.folder.getStatus().saving ||
			vocab.folder.getStatus().unsaved.length > 0,
	).toBe(false);
});

test('a stage press saves at once and keeps a note typed just before it', async () => {
	await using context = await setup();
	await using slow = await openVocab(
		await context.browser.open({ saveAfterMs: 60_000 }),
	);
	const { entries } = slow.vocab;
	const word = cached(slow.vocab, 'lucid');
	entries.setNote(word, 'clear');
	entries.setStage(word, 'understood');
	const edit = slow.vocab.folder.tables.entries.edit(word.id);
	await edit.save();
	const saved = expectOk(await context.folder.tables.entries.get(word.id));
	expect(saved?.fields).toMatchObject({ note: 'clear', stage: 'understood' });
	expect(edit.getPending()).toBeUndefined();
});

test("another tab's save reaches this page's list, and a save here keeps the field only the other tab changed", async () => {
	await using context = await setup();
	await using other = await openVocab(
		await context.browser.open({ saveAfterMs: 60_000 }),
	);
	const theirs = cached(other.vocab, 'lucid');
	// This page starts typing from the word as it read it.
	await using slow = await openVocab(
		await context.browser.open({ saveAfterMs: 60_000 }),
	);
	const mine = cached(slow.vocab, 'lucid');
	slow.vocab.entries.setNote(mine, 'mine');

	other.vocab.entries.setStage(theirs, 'usable');
	await other.vocab.folder.tables.entries.edit(theirs.id).save();
	await until(
		() => cached(context.vocab, 'lucid').stage === 'usable',
		'the other tab’s stage to reach this page',
	);

	await slow.vocab.folder.tables.entries.edit(mine.id).save();
	const saved = expectOk(await context.folder.tables.entries.get(mine.id));
	expect(saved?.fields).toMatchObject({ note: 'mine', stage: 'usable' });
});

test('a save over a note changed elsewhere wins the note', async () => {
	await using context = await setup();
	await using slow = await openVocab(
		await context.browser.open({ saveAfterMs: 60_000 }),
	);
	const word = cached(slow.vocab, 'lucid');
	slow.vocab.entries.setNote(word, 'mine');
	const stored = expectOk(await context.folder.tables.entries.get(word.id));
	if (stored === undefined) throw new Error('lucid is not saved');
	expectOk(
		await context.folder.tables.entries.set(word.id, stored, {
			fields: { note: 'theirs' },
		}),
	);
	await slow.vocab.folder.tables.entries.edit(word.id).save();
	expect(
		expectOk(await context.folder.tables.entries.get(word.id))?.fields?.note,
	).toBe('mine');
});

test('a saved stage stays shown when the reread fails, and pressing the old stage again saves that revert', async () => {
	await using context = await setup();
	const { vocab, folder } = context;
	const word = context.word();
	const list = folder.tables.entries.list;
	folder.tables.entries.list = async () => {
		throw new Error('Read failed');
	};
	try {
		const card = vocab.entries.edit(word.id);
		expect(card.markdown?.fields?.stage).toBe('new');
		expect(card.setStage('usable')).toBe(true);
		await folder.tables.entries.edit(word.id).save();
		await quiet(vocab);
		// The list still holds the word as read before the save.
		expect(context.word().stage).toBe('new');
		expect(card.pending).toBeUndefined();
		expect(card.markdown?.fields?.stage).toBe('usable');

		expect(card.setStage('new')).toBe(true);
		await folder.tables.entries.edit(word.id).save();
		expect(card.markdown?.fields?.stage).toBe('new');
	} finally {
		folder.tables.entries.list = list;
	}
	expect(expectOk(await folder.tables.entries.get(word.id))?.fields?.stage).toBe(
		'new',
	);
});

test('a save that fails keeps the typing and its error, and saving again writes it', async () => {
	await using context = await setup();
	const { vocab, folder } = context;
	using saves = failSaves();
	const edit = folder.tables.entries.edit(context.word().id);
	vocab.entries.setNote(context.word(), 'clear');
	await edit.save();
	expect(edit.getPending()?.error?.name).toBe('StorageFailed');
	expect(edit.getMarkdown()?.fields?.note).toBe('clear');
	expect(vocab.entries.failures.map((failure) => failure.kind === 'document' ? failure.fields : undefined)).toEqual([
		{ note: 'clear' },
	]);
	expect(context.word().note).toBe('');

	saves.failing = false;
	await edit.save();
	expect(edit.getPending()).toBeUndefined();
	expect(
		expectOk(await folder.tables.entries.get(context.word().id))?.fields?.note,
	).toBe('clear');
});

test('fields the schema does not name, and the body, survive a note save', async () => {
	await using context = await setup();
	const path = 'entries/handwritten.md';
	await put(
		context.folder,
		path,
		'---\ntext: serendipity\nnote: ""\nstage: new\ncreatedAt: 2026-01-01T00:00:00.000Z\nsource: a novel\n---\nSeen in chapter 3.\n',
	);
	await quiet(context.vocab);
	const word = cached(context.vocab, 'serendipity');
	expect(word.id).toBe('handwritten');
	// Found by its text under another name: adding it again writes nothing.
	expect(expectOk(await context.vocab.entries.add('serendipity'))).toBe(
		'present',
	);

	context.vocab.entries.setNote(word, 'luck');
	await context.folder.tables.entries.edit(word.id).save();
	const saved = expectOk(await context.folder.tables.entries.get(word.id));
	expect(saved?.fields).toMatchObject({ note: 'luck', source: 'a novel' });
	expect(saved?.body).toBe('Seen in chapter 3.\n');
	// The lines it did not change are kept as they were written.
	expect(saved?.text).toContain('\nsource: a novel\n');
});

test('a file that is not a valid word is named for repair, written as typed text, and reads as a word once repaired', async () => {
	await using context = await setup();
	const { vocab, folder } = context;
	const broken =
		'---\ntext: lurid\nnote: ""\nstage: mastered\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\n';
	const unparsed = '---\ntext: [\n---\n';
	await put(folder, 'entries/broken.md', broken);
	await put(folder, 'entries/unparsed.md', unparsed);
	await quiet(vocab);
	expect(repairsOf(rows(vocab))).toMatchObject([
		{ path: 'entries/broken.md', id: 'broken' },
		{ path: 'entries/unparsed.md', id: 'unparsed' },
	]);
	expect(wordsOf(rows(vocab)).map((word) => word.text)).toEqual(['lucid']);

	const { repair } = vocab.entries;
	expect(repair.start('broken')).toBe(true);
	// The list read the file; the repair shows its exact text.
	const view = repair.view()!;
	expect(view.text).toBe(broken);
	// Switching repairs leaves the first path's input with the folder.
	view.replaceText(broken.replace('stage: mastered', 'stage: usab'));
	expect(repair.start('unparsed')).toBe(true);
	expect(repair.start('broken')).toBe(true);
	expect(
		vocab.folder.getStatus().saving ||
			vocab.folder.getStatus().unsaved.length > 0,
	).toBe(true);
	expect(view.text).toBe(broken.replace('stage: mastered', 'stage: usab'));
	view.replaceText(broken.replace('stage: mastered', 'stage: usable'));
	await until(() => repair.view()?.pending === undefined, 'the repair to save');
	await quiet(vocab);
	expect(await fileText(folder, 'entries/broken.md')).toBe(
		broken.replace('stage: mastered', 'stage: usable'),
	);
	expect(cached(vocab, 'lurid')).toMatchObject({
		id: 'broken',
		stage: 'usable',
	});
	expect(repairsOf(rows(vocab)).map((file) => file.id)).toEqual(['unparsed']);
	expect(await repair.close()).toBe(true);
	expect(repair.open).toBeUndefined();
	// The file it was not told to change is as it was.
	expect(await fileText(folder, 'entries/unparsed.md')).toBe(unparsed);
});

test('a valid unsaved repair returns to structured editing without saving or refreshing', async () => {
	await using browser = createBrowser();
	const folder = await browser.open({ saveAfterMs: 60_000 });
	const path = 'entries/broken.md';
	const broken = '---\ntext: lucid\nnote: ""\nstage: invalid\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\n';
	await put(folder, path, broken);
	await using opened = await openVocab(folder);
	const { repair } = opened.vocab.entries;
	expect(repair.start('broken')).toBe(true);
	const fileEdit = repair.view()!;
	const fixed = broken.replace('stage: invalid', 'stage: usable');
	expectOk(fileEdit.replaceText(fixed));
	expect(fileEdit.markdown?.issues).toBeNull();
	expect(repair.close()).toBe(true);
	expect(repair.open).toBeUndefined();
	expect(await fileText(folder, path)).toBe(broken);
	expect(opened.vocab.entries.edit('broken').markdown?.fields?.stage).toBe('usable');
	expect(fileEdit.pending).toBeDefined();
});

test('a delete waits for the typing to save, then removes the word', async () => {
	await using context = await setup();
	const { vocab, folder } = context;
	await using slow = await openVocab(
		await context.browser.open({ saveAfterMs: 60_000 }),
	);
	const word = cached(slow.vocab, 'lucid');
	slow.vocab.entries.setNote(word, 'clear');
	const deleting = slow.vocab.entries.delete(word);
	expect(slow.vocab.entries.isLocked(word.id)).toBe(true);
	expect(slow.vocab.entries.setNote(word, 'more')).toBe(false);
	expect(expectOk(await deleting)).toEqual({ deleted: true });
	expect(await tableFiles(folder, 'entries')).toEqual([]);
	expect(
		slow.vocab.folder.tables.entries.edit(word.id).getPending(),
	).toBeUndefined();
	await until(
		() => wordsOf(rows(vocab)).length === 0,
		'the delete to reach the other list',
	);
});

test('typing that failed to save keeps its word from being deleted', async () => {
	await using context = await setup();
	const { vocab, folder } = context;
	using saves = failSaves();
	const edit = folder.tables.entries.edit(context.word().id);
	vocab.entries.setNote(context.word(), 'clear');
	await edit.save();
	expect(expectErr(await vocab.entries.delete(context.word())).name).toBe(
		'NotStarted',
	);
	saves.failing = false;
	expect(await tableFiles(folder, 'entries')).toEqual([context.path]);
	expect(edit.getPending()).toBeDefined();
	// Discarding is the learner's explicit choice, and lets the delete go ahead.
	expect(edit.discard()).toMatchObject({ fields: { note: 'clear' } });
	expect(expectOk(await vocab.entries.delete(context.word()))).toEqual({
		deleted: true,
	});
});

test('a note saved to a word deleted elsewhere brings the word back with the note: an edit beats an unseen delete', async () => {
	await using context = await setup();
	await using slow = await openVocab(
		await context.browser.open({ saveAfterMs: 60_000 }),
	);
	const word = cached(slow.vocab, 'lucid');
	slow.vocab.entries.setNote(word, 'clear');
	expectOk(await context.folder.tables.entries.delete(word.id, word.row));
	await slow.vocab.folder.tables.entries.edit(word.id).save();
	expect(
		expectOk(await context.folder.tables.entries.get(word.id))?.fields,
	).toMatchObject({ text: 'lucid', note: 'clear' });
});

test('close saves typing still waiting for its pause, and refuses input from then on', async () => {
	const browser = createBrowser();
	const folder = await browser.open({ saveAfterMs: 60_000 });
	const opened = await openVocab(folder);
	const { vocab, context } = opened;
	expectOk(await vocab.entries.add('lucid'));
	const word = cached(vocab, 'lucid');
	vocab.entries.setNote(word, 'clear');

	expect(await context.close()).toEqual([]);
	expect(vocab.entries.setNote(word, 'more')).toBe(false);
	expect(expectErr(await vocab.entries.add('opaque')).name).toBe('NotStarted');
	expect(
		expectErr(await vocab.chats.start([{ entryId: word.id, text: 'lucid' }]))
			.name,
	).toBe('NotSaved');

	const reopened = await browser.open();
	expect((await savedWords(reopened)).map((entry) => entry.note)).toEqual([
		'clear',
	]);
	await opened[Symbol.asyncDispose]();
	await browser[Symbol.asyncDispose]();
});

test('close sends a whole-file repair draft before releasing the folder', async () => {
	const browser = createBrowser();
	const folder = await browser.open({ saveAfterMs: 60_000 });
	const source = '---\ntext: [\n---\n';
	await put(folder, 'entries/broken.md', source);
	const opened = await openVocab(folder);
	const repair = opened.vocab.entries.repair;
	expect(repair.start('broken')).toBe(true);
	expectOk(repair.view()!.replaceText('---\ntext: repaired\n---\n'));
	await opened.context.close();
	const reopened = await browser.open();
	expect(await fileText(reopened, 'entries/broken.md')).toContain(
		'text: repaired',
	);
	await reopened.close();
	await opened[Symbol.asyncDispose]();
	await browser[Symbol.asyncDispose]();
});

test('a word is one plain Markdown file named by its text under entries/', async () => {
	await using browser = createBrowser();
	const folder = await browser.open();
	await using opened = await openVocab(folder);
	expectOk(await opened.vocab.entries.add('lucid'));
	// The folder holds plain Markdown files under the table names.
	expect(await tableFiles(folder, 'entries')).toEqual([
		`entries/${idOf('lucid')}.md`,
	]);
	expect(await fileText(folder, `entries/${idOf('lucid')}.md`)).toMatch(
		/^---\n[\s\S]*text: lucid\n[\s\S]*---\n$/,
	);
});
