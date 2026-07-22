import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';

import { openBunRecordOwner } from './bun-record-owner.js';
import { defineLens, defineTable } from './lens.js';

test('Bun owner publishes only complete read-only snapshot artifacts', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-bun-owner-'));
	const snapshotDirectory = join(directory, 'snapshots');
	await mkdir(snapshotDirectory);
	const debris = join(snapshotDirectory, '.snapshot-crashed.pending');
	const publishedDebris = join(
		snapshotDirectory,
		'snapshot-aaaaaaaaaaaaaaaaaaaaaaaa.sqlite3',
	);
	await writeFile(debris, 'incomplete');
	await writeFile(publishedDebris, 'orphaned');
	const opened = await openBunRecordOwner({ directory });
	try {
		expect(await Bun.file(debris).exists()).toBe(false);
		expect(await Bun.file(publishedDebris).exists()).toBe(false);
		opened.replica.localWrite({
			address: {
				namespace: 'so.epicenter.notes',
				collection: 'notes',
				recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			},
			op: 'replace',
			value: { title: 'Captured' },
		});
		const lens = defineLens({
			namespace: 'so.epicenter.notes',
			title: 'Notes',
			description: 'Snapshot fixture.',
			collections: {
				notes: defineTable({
					title: 'Notes',
					fields: { title: field.string() },
					optional: [],
				}),
			},
		});
		const snapshot = await opened.captureSnapshot({ lens });
		expect(snapshot.metadata).toMatchObject({
			kind: 'snapshot',
			recordCount: 1,
		});
		expect(snapshot.path).toMatch(
			/\/snapshots\/snapshot-[a-z0-9]{24}\.sqlite3$/,
		);
		const artifact = new Database(snapshot.path, {
			readonly: true,
			strict: true,
		});
		try {
			expect(artifact.query('SELECT id, title FROM notes').get()).toEqual({
				id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
				title: 'Captured',
			});
			expect(() => artifact.run('DELETE FROM _epicenter_records')).toThrow();
		} finally {
			artifact.close();
		}
	} finally {
		await opened.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});
