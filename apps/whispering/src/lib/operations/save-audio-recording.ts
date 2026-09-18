import type { BlobAlreadyExists, BlobStoreFailed } from '@epicenter/blobs';
import { InstantString } from '@epicenter/data/field';
import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '../whispering/recording.js';
import type { RecordingCreationError } from '../whispering/recordings.js';

/** Save imported or voice-activated audio; null means retirement after publication. */
export async function saveAudioRecording(
	app: Pick<WhisperingApp, 'signal' | 'blobs' | 'recordings'>,
	audio: Blob,
): Promise<
	Result<
		Recording | null,
		BlobAlreadyExists | BlobStoreFailed | RecordingCreationError
	>
> {
	app.signal.throwIfAborted();
	const recordedAt = InstantString.now();
	const recordedAtZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const saved = await app.blobs.local.add(audio);
	if (saved.error !== null) return saved;
	// Retirement retains committed bytes without failing the producer drain.
	if (app.signal.aborted) return Ok(null);
	return app.recordings.create({
		audioBlobId: saved.data,
		recordedAt,
		recordedAtZone,
		duration: null,
	});
}
