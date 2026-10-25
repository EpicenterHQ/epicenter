import { expect, test } from 'bun:test';
import { readRow } from '@epicenter/folder/next';
import { expectOk } from 'wellcrafted/testing';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';

const { createEntries } = await import('./entries.svelte.js');

import { rowPath, vocabTables } from './data.js';
import { createMemory, until } from './folder.test-support.js';

const raw = (text: string, note = '', stage = 'new') =>
	`---\ntext: ${text}\nnote: ${note}\nstage: ${stage}\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\nBody`;

test('add trims, replaces lone surrogates, and lists the saved word before answering', async () => {
	const { folder, core } = await createMemory();
	const entries = createEntries(folder);
	expect(expectOk(await entries.add('  lucid  '))).toBe('added');
	expect(entries.words.map((entry) => entry.text)).toEqual(['lucid']);
	expect(expectOk(await entries.add('lucid'))).toBe('present');
	expect(expectOk(await entries.add('  \ud800  '))).toBe('added');
	expect(entries.words.some((entry) => entry.text === '\ufffd')).toBe(true);
	expect((await entries.add('  ')).error?.name).toBe('Empty');
	await core.close();
});

test('concurrent adds create one word', async () => {
	const { folder, core } = await createMemory();
	const entries = createEntries(folder);
	const results = await Promise.all([
		entries.add('lucid'),
		entries.add('lucid'),
	]);
	expect(results.map((result) => result.error?.name)).toEqual([
		undefined,
		undefined,
	]);
	expect(results.map((result) => result.data).sort()).toEqual([
		'added',
		'present',
	]);
	expect(entries.words).toHaveLength(1);
	await core.close();
});

test('a different file at the hashed path is Taken', async () => {
	const { folder, core } = await createMemory();
	const entries = createEntries(folder);
	expectOk(await entries.add('lucid'));
	const id = entries.words[0]!.id;
	expectOk(
		await folder.tables.entries.update(id, { fields: { text: 'other' } }),
	);
	expect((await entries.add('lucid')).error?.name).toBe('Taken');
	await core.close();
});

test('note and stage updates set only named fields over the current file', async () => {
	const { folder, core, host } = await createMemory();
	const entries = createEntries(folder);
	expectOk(await entries.add('lucid'));
	const id = entries.words[0]!.id;
	const path = rowPath('entries', id);
	host.outside(
		path,
		raw('lucid', 'outside').replace(
			'note: outside',
			'note: outside\nextra: kept',
		),
	);
	await folder.refresh();
	expectOk(await entries.setStage(id, 'usable'));
	expect(host.text(path)).toContain('extra: kept');
	expect(host.text(path)).toContain('Body');
	expectOk(await entries.setNote(id, 'new note'));
	const read = readRow(host.text(path)!, vocabTables.entries);
	expect(read.issues).toBeNull();
	expect(read.fields?.note).toBe('new note');
	expect(read.fields?.stage).toBe('usable');
	await core.close();
});

test('repair as text writes a valid row before returning to the word card', async () => {
	const { folder, core, host } = await createMemory({
		'entries/broken.md': 'broken frontmatter',
	});
	const entries = createEntries(folder);
	expect(entries.repairs[0]?.id).toBe('broken');
	entries.repair.start('broken');
	const repaired = raw('lucid', 'clear');
	expectOk(await folder.write('entries/broken.md', repaired));
	expect(entries.repair.close(repaired)).toBe(true);
	expect(entries.repair.open).toBeUndefined();
	expect(entries.words[0]?.note).toBe('clear');
	expect(host.text('entries/broken.md')).toBe(repaired);
	expectOk(await entries.delete('broken'));
	expect(folder.tables.entries.row('broken')).toBeUndefined();
	await core.close();
});

test('repair stays open until its valid text has landed', async () => {
	const { folder, core, host } = await createMemory({
		'entries/broken.md': 'broken frontmatter',
	});
	const entries = createEntries(folder);
	entries.repair.start('broken');
	const gate = Promise.withResolvers<void>();
	host.control.putGate = gate.promise;
	const repaired = raw('lucid', 'clear');
	const saving = folder.write('entries/broken.md', repaired);
	await Bun.sleep(0);
	expect(entries.repair.open).toBe('broken');
	gate.resolve();
	expectOk(await saving);
	expect(entries.repair.close(repaired)).toBe(true);
	expect(entries.repair.open).toBeUndefined();
	await core.close();
});

test('an outside invalid edit keeps repair open after a valid draft', async () => {
	const { folder, core, host } = await createMemory({
		'entries/broken.md': 'broken frontmatter',
	});
	const entries = createEntries(folder);
	entries.repair.start('broken');
	const repaired = raw('lucid', 'clear');
	expectOk(await folder.write('entries/broken.md', repaired));
	host.outside('entries/broken.md', 'invalid again', { hint: true });
	await folder.refresh();
	await until(() => {
		const row = folder.tables.entries.row('broken');
		return row !== undefined && row.issues !== null;
	}, 'outside invalid row');
	expect(entries.repair.close(repaired)).toBe(false);
	expect(entries.repair.open).toBe('broken');
	await core.close();
});

test('a write after close answers Closed', async () => {
	const { folder, core } = await createMemory();
	const entries = createEntries(folder);
	await core.close();
	expect((await entries.setNote('missing', 'x')).error?.name).toBe('Closed');
});
