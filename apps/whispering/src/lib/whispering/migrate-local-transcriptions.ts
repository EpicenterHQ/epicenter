import { InstantString } from '@epicenter/app/field';
import type { LocalStore } from './local.js';

/** Copy older recording-wide text into result rows before the UI reads history. */
export async function migrateLocalTranscriptions(
	store: Pick<LocalStore, 'tables' | 'stored' | 'transact' | 'persistence'>,
): Promise<void> {
	const migrated = new Set(
		store.tables.transcriptions.rows
			.map((result) => result.legacyRecordingId)
			.filter((id): id is string => id !== null),
	);
	const legacy = store.stored().tables.get('recordings');
	if (!legacy) return;
	const pending = [...legacy].flatMap(([recordingId, values]) => {
		if (migrated.has(recordingId)) return [];
		const {
			transcript,
			polishedTranscript,
			recordedAt,
			transcriptionCompletedAt,
		} = values;
		if (typeof transcript !== 'string' || !transcript.trim()) return [];
		const recording = store.tables.recordings.get(recordingId);
		if (!recording) return [];
		const completedAt = InstantString.is(transcriptionCompletedAt)
			? transcriptionCompletedAt
			: InstantString.is(recordedAt)
				? recordedAt
				: recording.recordedAt;
		return [
			{
				recordingId,
				attemptedAt: recording.recordedAt,
				completedAt,
				rawText: transcript,
				cleanedText:
					typeof polishedTranscript === 'string' &&
					polishedTranscript !== transcript
						? polishedTranscript
						: null,
				connectionId: null,
				model: null,
				legacyRecordingId: recordingId,
			},
		];
	});
	if (pending.length === 0) return;
	store.transact(() => {
		for (const row of pending) store.tables.transcriptions.create(row);
	});
	await store.persistence.flush();
	if (store.persistence.get() !== 'saved')
		throw new Error('Local transcription migration was not saved.');
}
