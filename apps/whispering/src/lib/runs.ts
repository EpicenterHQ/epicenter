/**
 * A transcription: send a recording's audio to the transcription model, and
 * keep the transcript beside it.
 *
 * `transcribe` answers one `Result`: it reads the recording's audio as it is
 * now, sends it to the model chosen now, and writes the answer as a new
 * transcript note (every field fixed, the answer as its body). So a
 * transcript always holds an answer. A run that fails at any step answers
 * why, and nothing is kept for it: running it again sends again. Nothing
 * here is Svelte; the library wraps it as a mutation, and a run's state is
 * its mutation's.
 *
 * The same recording is not transcribed twice at once: a second run is
 * refused while the first is out. That is decided here, synchronously, so
 * two presses in one moment cannot both pass.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingFolder } from './folder.js';
import { timeId } from './format/ids.js';
import type { Audio, Target } from './inference.js';

export const RunError = defineErrors({
	/** Nothing was sent: the run could not be prepared, or is refused now. */
	NotSent: ({ reason }: { reason: string }) => ({ message: reason, reason }),
	/** The request failed: no answer was received. */
	NoAnswer: ({ reason }: { reason: string }) => ({
		message: `No answer was received: ${reason}`,
		reason,
	}),
	/** The answer arrived, and its note could not be written. */
	NotSaved: ({ reason }: { reason: string }) => ({
		message: `The answer arrived, but its transcript was not saved: ${reason} Transcribe again to send it again.`,
		reason,
	}),
});
export type RunError = InferErrors<typeof RunError>;

/**
 * A received answer as its note's body: the text, ending in one newline of
 * its own. An empty answer is a newline.
 */
const resultBody = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

export function createRuns({
	folder,
	chosen,
	transcribe,
	refused,
}: {
	/** Where the audio is read from and the transcripts are written. */
	folder: Pick<WhisperingFolder, 'readAudio' | 'notes'>;
	/** The transcription model chosen now, as where a request would go, or why there is none. */
	chosen: () => Result<Target, string>;
	/** Send `audio` to `target`. Nothing is written by this, and it never throws. */
	transcribe: (
		target: Target,
		audio: Audio,
	) => Promise<Result<{ text: string }, { message: string }>>;
	/** Why nothing new starts now, for recording `recordingId` or at all. */
	refused: (recordingId?: string) => string | undefined;
}) {
	/** The recordings being transcribed now. */
	const running = new Set<string>();

	return {
		/**
		 * Transcribe recording `recordingId`: read its audio, send it to the
		 * transcription model chosen now, and keep the transcript beside it.
		 * Refused while it is already being transcribed.
		 */
		async transcribe({
			recordingId,
		}: {
			recordingId: string;
		}): Promise<Result<undefined, RunError>> {
			const why = refused(recordingId);
			if (why !== undefined) return RunError.NotSent({ reason: why });
			if (running.has(recordingId))
				return RunError.NotSent({
					reason: 'This recording is already being transcribed.',
				});
			running.add(recordingId);
			try {
				const { data: target, error: unchosen } = chosen();
				if (unchosen !== null) return RunError.NotSent({ reason: unchosen });
				const audio = await folder.readAudio(recordingId);
				if (audio.error !== null)
					return RunError.NotSent({ reason: audio.error });
				const at = new Date();
				const answer = await transcribe(target, audio.data);
				if (answer.error !== null)
					return RunError.NoAnswer({ reason: answer.error.message });
				// A page closing keeps nothing that arrives after it.
				const closing = refused();
				if (closing !== undefined)
					return RunError.NotSaved({ reason: closing });
				const saved = await folder.notes.set({
					collection: 'transcriptions',
					id: timeId(at),
					fields: {
						recordingId,
						createdAt: at.toISOString(),
						model: target.model,
						endpoint: target.address,
					},
					body: { seen: null, text: resultBody(answer.data.text) },
				});
				if (saved.error !== null)
					return RunError.NotSaved({ reason: saved.error.message });
				return Ok(undefined);
			} finally {
				running.delete(recordingId);
			}
		},
		/**
		 * Why recording `recordingId` cannot be deleted now: it is being
		 * transcribed, which would leave a transcript naming a recording that
		 * is gone.
		 */
		busy: (recordingId: string): string | undefined =>
			running.has(recordingId)
				? 'This recording is still being transcribed. Wait for it to finish, then delete it.'
				: undefined,
	};
}

export type Runs = ReturnType<typeof createRuns>;
