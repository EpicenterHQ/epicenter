import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopRecordEpicenterOwner } from '@epicenter/data/desktop-record-owner';
import { defineLens, defineTable } from '@epicenter/data/record';
import { field } from '@epicenter/field';

import { createSnapshotQueryService } from './snapshot-query.ts';
import { createSnapshotQueryProcessRunner } from './snapshot-query-process.ts';

const lens = defineLens({
	namespace: 'so.epicenter.notes',
	title: 'Notes',
	description: 'Snapshot query fixture.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: { title: field.string() },
			optional: [],
		}),
	},
});

test('Home queries only registered snapshot artifacts through bounded read-only handles', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-query-service-'));
	const owner = await createDesktopRecordEpicenterOwner({ directory });
	let artifactPath: string | undefined;
	const snapshots = createSnapshotQueryService({
		async captureSnapshot(options) {
			const artifact = await owner.captureSnapshot(options);
			artifactPath = artifact.path;
			return artifact;
		},
		lenses: { chat: lens, honeycrisp: lens, whispering: lens },
	});
	try {
		await owner.epicenter.bind({ notes: lens }).notes.notes.create({
			title: 'Captured',
		});
		const snapshot = await snapshots.capture('raw');
		const firstArtifactPath = artifactPath;
		expect(snapshot).toMatchObject({
			kind: 'snapshot',
			lens: 'raw',
			recordCount: 1,
		});
		expect('path' in snapshot).toBe(false);
		expect(
			await snapshots.query(
				snapshot.id,
				`SELECT json_extract(payload_json, '$.title') AS title
				FROM _epicenter_records`,
			),
		).toEqual({
			rows: [{ title: 'Captured' }],
			rowCount: 1,
			truncated: false,
		});
		await expect(
			snapshots.query(snapshot.id, 'DELETE FROM _epicenter_records'),
		).rejects.toThrow();
		const vacuumPath = join(directory, 'escaped.sqlite3');
		await expect(
			snapshots.query(
				snapshot.id,
				`VACUUM INTO '${vacuumPath.replaceAll("'", "''")}'`,
			),
		).rejects.toThrow('must begin with');
		expect(await Bun.file(vacuumPath).exists()).toBe(false);
		const capped = await snapshots.query(
			snapshot.id,
			`WITH RECURSIVE counter(value) AS (
				VALUES (1) UNION ALL SELECT value + 1 FROM counter WHERE value < 501
			) SELECT value FROM counter`,
		);
		expect(capped).toMatchObject({ rowCount: 500, truncated: true });
		const replacement = await snapshots.capture('chat');
		expect(firstArtifactPath).toBeDefined();
		expect(await Bun.file(firstArtifactPath as string).exists()).toBe(false);
		await expect(snapshots.query(snapshot.id, 'SELECT 1')).rejects.toThrow(
			'Snapshot does not exist',
		);
		expect(replacement.lens).toBe('chat');
		const impatientQuery = createSnapshotQueryProcessRunner({ timeoutMs: 100 });
		await expect(
			impatientQuery({
				path: artifactPath as string,
				sql: `WITH RECURSIVE infinite(value) AS (
					VALUES (1) UNION ALL SELECT value + 1 FROM infinite
				) SELECT count(*) FROM infinite`,
			}),
		).rejects.toThrow('exceeded 100 milliseconds');
	} finally {
		await snapshots[Symbol.asyncDispose]();
		if (artifactPath !== undefined) {
			expect(await Bun.file(artifactPath).exists()).toBe(false);
		}
		await owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});
