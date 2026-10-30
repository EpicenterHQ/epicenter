/**
 * Transcription on this computer, with Epicenter's one active local model
 * (ADR-0180).
 *
 * Epicenter's Settings chooses and downloads that model; Whispering never
 * does. Whispering asks which installed model is active, reads the audio a
 * row names from its folder, and hands the bytes to Epicenter's
 * `transcribe_audio_bytes` with that model's id. Nothing leaves the computer.
 *
 * The commands are the shell's typed bindings, granted to Whispering's
 * windows (`whispering.json` in Epicenter's capabilities). They are injected
 * so tests can answer them.
 */
import { Ok, type Result } from 'wellcrafted/result';
import type { commands as shellCommands } from '../../tauri/bindings.gen.js';
import {
	type LocalTranscription,
	TranscriptionError,
} from '../../transcription.js';

/** The commands this uses, as the generated bindings type them. */
export type LocalTranscriptionCommands = Pick<
	typeof shellCommands,
	| 'getLocalTranscriptionReadiness'
	| 'listInferenceModels'
	| 'transcribeAudioBytes'
	| 'openHome'
>;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export function createLocalTranscription({
	commands,
	readAudio,
}: {
	commands: LocalTranscriptionCommands;
	/** The bytes at a folder-relative path, or why they could not be read. */
	readAudio: (path: string) => Promise<Result<Uint8Array, string>>;
}): LocalTranscription {
	return {
		async readiness() {
			const readiness = await commands.getLocalTranscriptionReadiness();
			return readiness.status === 'ready'
				? { ready: true }
				: { ready: false, message: readiness.message };
		},

		async transcribe(audioPath) {
			let model: string | undefined;
			try {
				model = (await commands.listInferenceModels()).find(
					(candidate) => candidate.active,
				)?.id;
				if (model === undefined) {
					const readiness = await commands.getLocalTranscriptionReadiness();
					return TranscriptionError.ConnectionUnavailable({
						reason:
							readiness.status === 'unavailable'
								? `${readiness.message} Choose a model in Epicenter’s Settings.`
								: 'no local model is active on this computer. Choose one in Epicenter’s Settings.',
					});
				}
			} catch (cause) {
				return TranscriptionError.ConnectionUnavailable({
					reason: `Epicenter did not say which local model is active: ${describe(cause)}`,
				});
			}
			const { data: bytes, error: readError } = await readAudio(audioPath);
			if (readError !== null)
				return TranscriptionError.AudioUnreadable({
					path: audioPath,
					reason: readError,
				});
			let answered: Awaited<ReturnType<typeof commands.transcribeAudioBytes>>;
			try {
				answered = await commands.transcribeAudioBytes(
					model,
					Array.from(bytes),
					{
						language: null,
						initialPrompt: null,
					},
				);
			} catch (cause) {
				// The command was asked and its answer never arrived.
				return TranscriptionError.HostUnavailable({ reason: describe(cause) });
			}
			const { data: outcome, error } = answered;
			if (error !== null)
				return error.name === 'LocalRouteUnavailable'
					? TranscriptionError.ConnectionUnavailable({
							reason: `${error.message} Choose a model in Epicenter’s Settings.`,
						})
					: TranscriptionError.LocalFailed({ reason: error.message });
			if (outcome.outcome === 'empty-audio') return Ok({ text: '', model });
			return Ok({ text: outcome.text, model: outcome.modelId });
		},

		openSettings: () => commands.openHome('transcription'),
	};
}
