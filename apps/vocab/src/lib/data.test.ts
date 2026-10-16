/**
 * Vocab folder declaration tests.
 * Pins the folder's ID and table names, which name its OPFS directory and
 * the table directories its files are saved under, and that the folder really
 * opens under that one ID every time without reading global IndexedDB. Also
 * pins which saved word a chat's focus item may control.
 */
import { expect, test } from 'bun:test';
import { APPS } from '@epicenter/constants/apps';
import { InstantString } from '@epicenter/definition/field';
import { expectOk } from 'wellcrafted/testing';
import { focusWord, readEntry, readRows, vocabFolder } from './data.js';
import { VOCAB_FOLDER_ID } from './folder.js';
import { createBrowser } from './folder.test-support.js';

test('one folder under the app ID holds words, chats, and messages', () => {
	expect(VOCAB_FOLDER_ID).toBe(APPS.VOCAB.id);
	expect(Object.keys(vocabFolder.tables)).toEqual([
		'entries',
		'chats',
		'messages',
	]);
	expect(Object.keys(vocabFolder.kv)).toEqual(['tutorConnection']);
});

test('the folder is this browser’s storage under the same name each time it opens', async () => {
	await using browser = createBrowser();
	const first = await browser.open();
	const location = first.location;
	expect(location).toEqual({
		kind: 'opfs',
		directory: 'so.epicenter.vocab',
	});
	await first.close();
	expect((await browser.open()).location).toEqual(location);
});

test('a focus controls only the saved word with both its ID and its text', async () => {
	await using browser = createBrowser();
	const folder = await browser.open();
	// The file at the focus ID now holds another word, as another program may leave it.
	expectOk(
		await folder.tables.entries.create(
			{
				fields: {
					text: 'lurid',
					note: '',
					stage: 'usable',
					createdAt: InstantString.now(),
				},
				body: '',
			},
			{ stem: 'lucid-id' },
		),
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

test('a word saved on a first open is there after reopening, and the IndexedDB globals are never read', async () => {
	// Any read of the globals is recorded and refused; they are put back after.
	// Storage handed to the opener by the test helper is not seen here.
	const read: string[] = [];
	const globals = ['indexedDB', 'IDBKeyRange'].map(
		(name) =>
			[name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
	);
	for (const [name] of globals)
		Object.defineProperty(globalThis, name, {
			configurable: true,
			get() {
				read.push(name);
				throw new Error(`${name} was read`);
			},
		});
	try {
		await using browser = createBrowser();
		const first = await browser.open();
		expectOk(
			await first.tables.entries.create(
				{
					fields: {
						text: 'lucid',
						note: 'clear',
						stage: 'new',
						createdAt: InstantString.now(),
					},
					body: '',
				},
				{ stem: 'lucid' },
			),
		);
		await first.close();
		const again = await browser.open();
		const reopened = expectOk(await again.tables.entries.get('lucid'));
		expect(reopened?.row.fields).toMatchObject({
			text: 'lucid',
			note: 'clear',
		});
	} finally {
		for (const [name, descriptor] of globals)
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
	}
	expect(read).toEqual([]);
});
