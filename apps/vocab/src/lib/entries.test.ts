/**
 * The learner's words over one client's `entries/{id}.md` notes.
 *
 * Key behaviors:
 * - Adding trims and normalizes, names the note by the text's SHA-256, and
 *   answers `present` for a word already saved; two adds make one word
 * - A different file at the word's path is `Taken`
 * - A stage change keeps keys and body it does not name; the note is the body
 * - A note that does not read is listed to repair, and `replace` repairs it
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

const { openVocabFolder, until } = await import('./vocab.test-support.js');
const { createEntries } = await import('./entries.svelte.js');

const note = (text: string, stage = 'new', body = '') =>
	`---\ntext: ${text}\nstage: ${stage}\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\n${body}`;

test('add trims, replaces lone surrogates, and lists the saved word before answering', async () => {
	await using folder = await openVocabFolder();
	const entries = createEntries(folder.lists.entries);
	expect(expectOk(await entries.add('  lucid  '))).toBe('added');
	expect(entries.words.map((entry) => entry.text)).toEqual(['lucid']);
	const id = entries.words[0]?.id ?? '';
	expect(id).toBe(new Bun.CryptoHasher('sha256').update('lucid').digest('hex'));
	expect(await folder.text(`entries/${id}.md`)).toMatch(
		/^---\ntext: lucid\nstage: new\ncreatedAt: "\S+"\n---\n$/,
	);
	expect(expectOk(await entries.add('lucid'))).toBe('present');
	expect(expectOk(await entries.add('  \ud800  '))).toBe('added');
	expect(entries.words.some((entry) => entry.text === '�')).toBe(true);
	expect((await entries.add('  ')).error?.name).toBe('Empty');
});

test('concurrent adds create one word', async () => {
	await using folder = await openVocabFolder();
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
	expect(await folder.files('entries')).toHaveLength(1);
});

test('a different file at the hashed path is Taken', async () => {
	await using folder = await openVocabFolder();
	const entries = createEntries(folder.lists.entries);
	expectOk(await entries.add('lucid'));
	const id = entries.words[0]?.id ?? '';
	expectOk(await folder.lists.entries.update({ id }, { text: 'other' }));
	expect((await entries.add('lucid')).error?.name).toBe('Taken');
});

test('a stage change keeps what it does not name, and the note is the body', async () => {
	const id = 'lucid';
	await using folder = await openVocabFolder({
		[`entries/${id}.md`]: note('lucid', 'new', 'My note').replace(
			'stage: new',
			'stage: new\nextra: kept',
		),
	});
	const entries = createEntries(folder.lists.entries);
	await until(() => entries.words.length === 1);
	expect(entries.words[0]?.note).toBe('My note');
	expectOk(await entries.setStage(id, 'usable'));
	expect(await folder.text(`entries/${id}.md`)).toBe(
		'---\ntext: lucid\nstage: usable\ncreatedAt: "2026-01-01T00:00:00.000Z"\nextra: kept\n---\nMy note',
	);
	expectOk(await folder.lists.entries.update({ id }, { body: 'New note' }));
	expect(entries.words[0]?.note).toBe('New note');
	expectOk(await entries.delete(id));
	expect(entries.words).toEqual([]);
	expect(await folder.files('entries')).toEqual([]);
});

test('a note that does not read is listed to repair, and replace repairs it', async () => {
	await using folder = await openVocabFolder({
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
	entries.repair.start('broken');
	expect(
		(
			await folder.lists.entries.replace(
				{ id: 'broken' },
				'---\ntext: lucid\n---\n',
			)
		).error?.name,
	).toBe('Invalid');
	expectOk(
		await folder.lists.entries.replace(
			{ id: 'broken' },
			note('lucid', 'new', 'clear'),
		),
	);
	expect(entries.repairs).toEqual([]);
	expect(entries.words[0]).toMatchObject({ id: 'broken', note: 'clear' });
});
