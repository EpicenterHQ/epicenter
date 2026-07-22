/** Whispering's Bun composition evidence over the record replica. */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import type { RecordingId } from '../workspace';
import { openWhisperingApp } from './app';
import { createWhisperingBunDependencies } from './app.bun';

test('one dataDir owns scalar records and row-addressed audio', async () => {
	const dataDir = mkdtempSync(join(tmpdir(), 'whispering-bun-app-'));
	try {
		let recordingId: RecordingId;
		{
			await using app = await openWhisperingApp(
				createWhisperingBunDependencies({ dataDir }),
			);
			const recording = await app.recordings.create({
				audio: {
					kind: 'bytes',
					bytes: new Blob(['audio'], { type: 'audio/wav' }),
				},
				title: 'Bun capture',
				recordedAt: InstantString.now(),
				recordedAtZone: 'UTC',
				transcript: '',
				polishedTranscript: null,
				duration: null,
				transcription: null,
			});
			recordingId = recording.id;
		}
		expect(existsSync(join(dataDir, 'epicenter.sqlite3'))).toBe(true);

		await using reopened = await openWhisperingApp(
			createWhisperingBunDependencies({ dataDir }),
		);
		expect(reopened.recordings.get(recordingId)?.title).toBe('Bun capture');
		expect(reopened.recordings.get(recordingId)?.audioMediaType).toBe(
			'audio/wav',
		);
		const audio = await reopened.recordings.readAudio(recordingId);
		expect(audio).not.toBeNull();
		expect(audio?.type).toBe('audio/wav');
		expect(await audio?.text()).toBe('audio');

		expectOk(await reopened.recordings.delete(recordingId));
		expect(await reopened.recordings.readAudio(recordingId)).toBeNull();
		await reopened.recordings.refresh();
		expect(reopened.recordings.get(recordingId)).toBeUndefined();
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
