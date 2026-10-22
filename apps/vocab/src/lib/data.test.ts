/**
 * Vocab table tests.
 * Pins the table names, which name the directories its files are saved
 * under, that the folder is this browser's one local folder, which starts
 * empty and keeps what was saved across reopening, and which saved word a
 * chat's focus item may control.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { focusWord, readEntry, readRows, vocabTables } from './data.js';
import { createBrowser, tableFiles } from './folder.test-support.js';

test('one folder holds words, chats, and messages', () => {
	expect(Object.keys(vocabTables)).toEqual(['entries', 'chats', 'messages']);
});

test('a fresh browser starts empty, and a word saved on a first open is there after reopening', async () => {
	await using browser = createBrowser();
	const first = await browser.open();
	expect(expectOk(await first.files.list())).toEqual([]);
	expectOk(
		await first.tables.entries.set('lucid', {
			fields: {
				text: 'lucid',
				note: 'clear',
				stage: 'new',
				createdAt: new Date().toISOString(),
			},
			body: '',
		}),
	);
	await first.close();
	const again = await browser.open();
	expect(await tableFiles(again, 'entries')).toEqual(['entries/lucid.md']);
	expect(
		expectOk(await again.tables.entries.get('lucid'))?.fields,
	).toMatchObject({
		text: 'lucid',
		note: 'clear',
	});
});

test('a focus controls only the saved word with both its ID and its text', async () => {
	await using browser = createBrowser();
	const folder = await browser.open();
	// The file at the focus ID now holds another word, as another program may leave it.
	expectOk(
		await folder.tables.entries.set('lucid-id', {
			fields: {
				text: 'lurid',
				note: '',
				stage: 'usable',
				createdAt: new Date().toISOString(),
			},
			body: '',
		}),
	);
	const { rows } = readRows(
		'entries',
		expectOk(await folder.tables.entries.list()),
		readEntry,
	);
	expect(
		focusWord(rows, { entryId: 'lucid-id', text: 'lucid' }),
	).toBeUndefined();
	expect(focusWord(rows, { entryId: 'lucid-id', text: 'lurid' })?.id).toBe(
		'lucid-id',
	);
});
