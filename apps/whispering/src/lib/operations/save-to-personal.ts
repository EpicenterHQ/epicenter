import { defineErrors } from 'wellcrafted/error';
import { tryAsync, trySync } from 'wellcrafted/result';
import type { RecordingId } from '../data.js';
import type { WhisperingApp } from '../whispering/app.js';
import { local } from '../whispering/local.js';
import type { PersonalStore } from '../whispering/personal.js';
import { recordingPublication } from './publish-recording.js';

const SaveToPersonalError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: 'Could not save this recording to Personal.',
		cause,
	}),
});

/** One independent copy, with page-lifetime recovery after bytes are published. */
export async function saveToPersonal(
	app: Pick<WhisperingApp, 'signal' | 'pendingSaves'>,
	personal: PersonalStore,
	recordingId: RecordingId,
) {
	const admission = trySync({
		try: () => {
			app.signal.throwIfAborted();
			const localRecording = local.tables.recordings.get(recordingId);
			if (!localRecording)
				throw new Error('The Local recording is missing or nonconforming.');
			const { id, ...values } = localRecording;
			if (
				values.transcriptionStatus !== 'completed' &&
				values.transcriptionStatus !== 'failed'
			) {
				values.transcriptionStatus = 'pending';
				values.transcriptionCompletedAt = null;
				values.transcriptionError = null;
			}
			return {
				values,
				receipt: app.pendingSaves.reserve('Personal recording'),
			};
		},
		catch: (cause) => SaveToPersonalError.Failed({ cause }),
	});
	if (admission.error) return admission;
	const { values, receipt } = admission.data;
	// No retry calls copyFrom again. A refused/uncertain byte transfer remains a
	// failed attempt; a known BlobId proceeds only to the retained publication.
	const copied = await tryAsync({
		try: () =>
			personal.blobs.copyFrom(local.blobs, values.audioBlobId, {
				signal: app.signal,
			}),
		catch: (cause) => SaveToPersonalError.Failed({ cause }),
	});
	if (copied.error) {
		receipt.discard();
		return copied;
	}
	if (copied.data.error) {
		receipt.discard();
		return copied.data;
	}
	return receipt.run(
		recordingPublication(
			personal,
			{ ...values, audioBlobId: copied.data.data },
			app.signal,
		),
	);
}
