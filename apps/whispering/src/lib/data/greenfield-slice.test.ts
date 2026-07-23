/** Whispering's inert Lens evidence over the Bun record replica. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunRecordEpicenter } from '@epicenter/data/bun';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { whisperingLens } from './lens';

function recording(title: string, recordedAt: InstantString) {
	return {
		title,
		audioMediaType: 'audio/wav',
		audioFileName: 'recording.wav',
		recordedAt,
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		transcription: null,
	};
}

test('settings bind directly through the Whispering Lens', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-settings-'));
	try {
		await using epicenter = await openBunRecordEpicenter({ directory: root });
		const settings = epicenter.bind({ whispering: whisperingLens }).whispering
			.settings;
		let changes = 0;
		const stop = settings.transcriptionLanguage.subscribe(() => {
			changes += 1;
		});
		expect(
			expectOk(await settings.transcriptionLanguage.get()),
		).toBeUndefined();
		await settings.transcriptionLanguage.set('en');
		expect(expectOk(await settings.transcriptionLanguage.get())).toBe('en');
		await settings.transcriptionLanguage.unset();
		expect(
			expectOk(await settings.transcriptionLanguage.get()),
		).toBeUndefined();
		expect(changes).toBe(2);
		stop();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('one recording address composes scalar CRUD and immutable audio', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-data-composition-'));
	try {
		await using epicenter = await openBunRecordEpicenter({ directory: root });
		const recordings = epicenter.bind({ whispering: whisperingLens }).whispering
			.recordings;
		const older = await recordings.create(
			recording(
				'older',
				InstantString.fromDate(new Date('2026-07-20T01:00:00.000Z')),
			),
		);
		const newer = await recordings.create(
			recording(
				'newer',
				InstantString.fromDate(new Date('2026-07-20T02:00:00.000Z')),
			),
		);
		await recordings.blob.put(older.id, new Blob(['audio']).stream());
		expect(await new Response(await recordings.blob.get(older.id)).text()).toBe(
			'audio',
		);
		const scanned = await recordings.scan();
		expect(
			scanned.rows.toSorted((left, right) =>
				right.recordedAt.localeCompare(left.recordedAt),
			)[0],
		).toEqual(newer);
		expect(
			expectOk(await recordings.update(older.id, { title: 'updated' }))?.title,
		).toBe('updated');
		expect(await recordings.delete(older.id)).toBe(true);
		expect(await recordings.blob.inspect(older.id)).toEqual({ kind: 'absent' });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
