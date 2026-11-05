/**
 * The learner's words over the folder's `entries/{id}.md` notes.
 *
 * Key behaviors:
 * - Adding trims and normalizes, names the note by the text's SHA-256, and
 *   answers `present` for a word already saved; two adds make one word
 * - A word is added only after the words were listed and `get` shows none
 * - A different file at the word's path is `Taken`
 * - An add while the store is out of reach waits, and lands once it is back
 * - A stage change keeps keys and body it does not name, and never makes a
 *   word deleted elsewhere again; the note is the body
 * - A note that does not read is listed to repair; text saved through its
 *   editor is written as typed, and repairs it once it reads
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

const { openVocabFolder, until } = await import('./vocab.test-support.js');
const { createEntries } = await import('./entries.svelte.js');

const note = (text: string, stage = 'new', body = '') =>
	`---\ntext: ${text}\nstage: ${stage}\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\n${body}`;
const hashOf = (text: string) =>
	new Bun.CryptoHasher('sha256').update(text).digest('hex');

test('add trims, replaces lone surrogates, and lists the saved word before answering', async () => {
	using folder = await openVocabFolder();
	const entries = createEntries(folder.lists.entries);
	expect(expectOk(await entries.add('  lucid  '))).toBe('added');
	expect(entries.words.map((entry) => entry.text)).toEqual(['lucid']);
	const id = entries.words[0]?.id ?? '';
	expect(id).toBe(hashOf('lucid'));
	expect(folder.files.read(`entries/${id}.md`)).toMatch(
		/^---\ntext: lucid\nstage: new\ncreatedAt: "\S+"\n---\n$/,
	);
	expect(expectOk(await entries.add('lucid'))).toBe('present');
	expect(expectOk(await entries.add('  \ud800  '))).toBe('added');
	expect(entries.words.some((entry) => entry.text === '�')).toBe(true);
	expect((await entries.add('  ')).error?.name).toBe('Empty');
});

test('concurrent adds create one word', async () => {
	using folder = await openVocabFolder();
	const entries = createEntries(folder.lists.entries);
	const results = await Promise.all([
		entries.add('lucid'),
		entries.add('lucid'),
	]);
	expect(results.map((result) => result.error)).toEqual([null, null]);
	expect(results.map((result) => result.data).sort()).toEqual([
		'added',
		'present',
	]);
	expect(entries.words).toHaveLength(1);
	expect(folder.files.paths('entries')).toHaveLength(1);
});

test('a saved word is present, not added again', async () => {
	const id = hashOf('lucid');
	const saved = note('lucid', 'usable', 'My note');
	using folder = await openVocabFolder({ [`entries/${id}.md`]: saved });
	// Another page's folder, once it connected.
	const other = folder.other();
	expect((await other.entries.list()).error).toBeNull();
	const entries = createEntries(other.entries);
	expect(expectOk(await entries.add('lucid'))).toBe('present');
	expect(folder.files.read(`entries/${id}.md`)).toBe(saved);
});

test('a different file at the hashed path is Taken', async () => {
	using folder = await openVocabFolder();
	const entries = createEntries(folder.lists.entries);
	expectOk(await entries.add('lucid'));
	const id = entries.words[0]?.id ?? '';
	await folder.lists.entries.set({ id }, { text: 'other' });
	expect((await entries.add('lucid')).error?.name).toBe('Taken');
});

test('an add while the store is out of reach waits, and lands once it is back', async () => {
	using folder = await openVocabFolder();
	const entries = createEntries(folder.lists.entries);
	const back = folder.files.refuse('offline', { under: 'entries' });
	let answered = false;
	const adding = entries.add('lucid').then((result) => {
		answered = true;
		return result;
	});
	await until(() => folder.lists.saving());
	await Bun.sleep(20);
	expect(answered).toBe(false);
	expect(folder.files.paths('entries')).toEqual([]);
	back();
	expect(expectOk(await adding)).toBe('added');
	expect(folder.files.paths('entries')).toEqual([`entries/${hashOf('lucid')}.md`]);
});

test('a stage change keeps what it does not name, and the note is the body', async () => {
	const id = 'lucid';
	using folder = await openVocabFolder({
		[`entries/${id}.md`]: note('lucid', 'new', 'My note').replace(
			'stage: new',
			'stage: new\nextra: kept',
		),
	});
	const entries = createEntries(folder.lists.entries);
	await until(() => entries.words.length === 1);
	expect(entries.words[0]?.note).toBe('My note');
	await entries.setStage(id, 'usable');
	expect(folder.files.read(`entries/${id}.md`)).toBe(
		'---\ntext: lucid\nstage: usable\ncreatedAt: "2026-01-01T00:00:00.000Z"\nextra: kept\n---\nMy note',
	);
	await folder.lists.entries.set({ id }, { body: 'New note' });
	expect(entries.words[0]?.note).toBe('New note');
	await entries.delete(id);
	expect(entries.words).toEqual([]);
	expect(folder.files.paths('entries')).toEqual([]);
	// A stage pressed on a word that is gone makes no note.
	await entries.setStage(id, 'new');
	expect(folder.files.paths('entries')).toEqual([]);
});

test('a note that does not read is listed to repair, and its text saved as typed repairs it once it reads', async () => {
	using folder = await openVocabFolder({
		'entries/broken.md': '---\ntext: [lucid\n---\nclear',
	});
	const entries = createEntries(folder.lists.entries);
	await until(() => entries.repairs.length === 1);
	expect(entries.repairs[0]).toMatchObject({
		id: 'broken',
		path: 'entries/broken.md',
		text: '---\ntext: [lucid\n---\nclear',
	});
	expect(entries.repairs[0]?.reason.length).toBeGreaterThan(0);
	const edit = folder.lists.entries.edit({ id: 'broken' });
	// Text that still does not fit is written, and the note stays to repair.
	edit.text = '---\ntext: lucid\n---\n';
	await edit.landed();
	expect(folder.files.read('entries/broken.md')).toBe('---\ntext: lucid\n---\n');
	expect(entries.repairs.map(({ id }) => id)).toEqual(['broken']);
	edit.text = note('lucid', 'new', 'clear');
	await edit.landed();
	expect(entries.repairs).toEqual([]);
	expect(entries.words[0]).toMatchObject({ id: 'broken', note: 'clear' });
});
