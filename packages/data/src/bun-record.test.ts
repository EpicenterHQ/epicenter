import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';

import { openBunRecordEpicenter } from './bun.js';
import { defineLens, defineTable } from './lens.js';

const lens = defineLens({
	namespace: 'so.epicenter.notes',
	title: 'Notes',
	description: 'Bun record opener test.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: { title: field.string() },
			optional: [],
		}),
	},
});

test('Bun record opener owns one durable SQLite replica and blob root', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-record-'));
	try {
		const first = await openBunRecordEpicenter({ directory });
		const row = await first.bind({ notes: lens }).notes.notes.create({
			title: 'Persisted',
		});
		await first[Symbol.asyncDispose]();

		const reopened = await openBunRecordEpicenter({ directory });
		try {
			expect(
				await reopened.bind({ notes: lens }).notes.notes.get(row.id),
			).toMatchObject({
				data: { id: row.id, title: 'Persisted' },
			});
		} finally {
			await reopened[Symbol.asyncDispose]();
		}
	} finally {
		await rm(directory, { recursive: true });
	}
});
