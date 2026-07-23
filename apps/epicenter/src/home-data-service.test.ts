/**
 * Home live data service tests.
 *
 * Verifies that Home traverses installed Lenses through bounded typed pages and
 * presents current sync and parked-work observations from the shared owner.
 *
 * Key behaviors:
 * - Catalog entries are derived from Lens definitions
 * - Table and values reads preserve conformance classification
 * - Invalid collections and unbounded page sizes are refused
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopRecordEpicenterOwner } from '@epicenter/data/desktop-record-owner';
import { defineLens, defineTable, defineValues } from '@epicenter/data/record';
import { field } from '@epicenter/field';

import { createHomeDataService } from './home-data-service.ts';

const lens = defineLens({
	namespace: 'so.epicenter.homedata',
	title: 'Notes',
	description: 'Live Home data fixture.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: { title: field.string() },
			optional: [],
		}),
		settings: defineValues({
			title: 'Settings',
			values: { theme: field.string() },
		}),
	},
});

test('Home pages live Lens data and reports owner work without SQL', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-home-data-'));
	const owner = await createDesktopRecordEpicenterOwner({ directory });
	const data = createHomeDataService({
		owner,
		lenses: { chat: lens, honeycrisp: lens, whispering: lens },
	});
	try {
		const bound = owner.epicenter.bind({ notes: lens }).notes;
		const row = await bound.notes.create({ title: 'Visible' });
		await bound.settings.theme.set('dark');

		const overview = await data.overview();
		expect(overview.lenses[0]).toMatchObject({
			id: 'chat',
			title: 'Notes',
			collections: [
				{ key: 'notes', kind: 'table', fields: ['title'] },
				{ key: 'settings', kind: 'values', fields: ['theme'] },
			],
		});
		expect(overview.sync.work.scalar.pending).toBe(2);
		expect(overview.parked.entries).toEqual([]);

		expect(
			await data.collection({
				lens: 'chat',
				collection: 'notes',
				limit: 1,
			}),
		).toMatchObject({
			kind: 'table',
			entries: [
				{
					recordKey: row.id,
					state: 'live',
					value: { id: row.id, title: 'Visible' },
				},
			],
		});
		expect(
			await data.collection({ lens: 'chat', collection: 'settings' }),
		).toMatchObject({
			kind: 'values',
			entries: [{ recordKey: 'theme', state: 'live', value: 'dark' }],
		});
		await expect(
			data.collection({ lens: 'chat', collection: 'missing' }),
		).rejects.toThrow("has no collection 'missing'");
		await expect(
			data.collection({ lens: 'chat', collection: 'notes', limit: 101 }),
		).rejects.toThrow('limit must be 1 through 100');
	} finally {
		await owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});
