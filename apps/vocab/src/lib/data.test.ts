import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { focusWord, readEntry, readRows, vocabTables } from './data.js';
import { createMemory } from './folder.test-support.js';

test('the three tables share one folder', async () => {
	expect(Object.keys(vocabTables)).toEqual(['entries', 'chats', 'messages']);
	const { folder, core } = await createMemory();
	expect(folder.files).toEqual([]);
	expectOk(
		await folder.tables.entries.create('lucid', {
			fields: {
				text: 'lucid',
				note: 'clear',
				stage: 'new',
				createdAt: new Date().toISOString(),
			},
		}),
	);
	expect(folder.tables.entries.row('lucid')?.issues).toBeNull();
	await core.close();
});

test('focus matches both the saved id and text', async () => {
	const { folder, core } = await createMemory();
	expectOk(
		await folder.tables.entries.create('lucid-id', {
			fields: {
				text: 'lurid',
				note: '',
				stage: 'usable',
				createdAt: new Date().toISOString(),
			},
		}),
	);
	const { rows } = readRows('entries', folder.tables.entries.rows, readEntry);
	expect(
		focusWord(rows, { entryId: 'lucid-id', text: 'lucid' }),
	).toBeUndefined();
	expect(focusWord(rows, { entryId: 'lucid-id', text: 'lurid' })?.id).toBe(
		'lucid-id',
	);
	await core.close();
});
