/**
 * Transcription on this computer, with Epicenter's one active local model
 * (ADR-0180).
 *
 * Epicenter's Settings chooses and downloads that model; Whispering never
 * does. Whispering asks which installed model is active, reads the audio a
 * row names from its folder, and hands the bytes to Epicenter's
 * `transcribe_audio_bytes` with that model's id. Nothing leaves the computer.
 *
 * The commands are the shell's typed bindings, granted to every installed
 * app's windows (`installed-app.json` in Epicenter's capabilities). They are
 * injected so tests can answer them.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { commands as shellCommands } from '../tauri/bindings.gen.js';

/** The commands this uses, as the generated bindings type them. */
export type LocalTranscriptionCommands = Pick<
	typeof shellCommands,
	| 'getLocalTranscriptionReadiness'
	| 'listInferenceModels'
	| 'transcribeAudioBytes'
	| 'openHome'
>;

export type LocalTranscriptionReadiness =
	| { readonly ready: true }
	| { readonly ready: false; readonly message: string };

/**
 * Transcription on this computer, reached through a `local` connection
 * (ADR-0557). A `local` row that names no model uses the active one, which
 * the row's result records exactly (ADR-0180).
 */
export type LocalTranscription = {
	/** Whether the active model can run now. Advisory: transcribing checks again. */
	readiness(): Promise<LocalTranscriptionReadiness>;
	/** The active model's exact id, or why there is none. */
	activeModel(): Promise<Result<string, string>>;
	/**
	 * Transcribe the audio at `audioPath` with `model`, an installed model's
	 * exact id. Nothing is written by this.
	 */
	transcribe(
		audioPath: string,
		model: string,
	): Promise<Result<{ text: string }, { message: string }>>;
	/** Open Epicenter's Settings where the local model is chosen. */
	openSettings(): Promise<void>;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const CHOOSE = 'Choose a model in Epicenter’s Settings.';

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

		async activeModel() {
			try {
				const model = (await commands.listInferenceModels()).find(
					(candidate) => candidate.active,
				)?.id;
				if (model !== undefined) return Ok(model);
				const readiness = await commands.getLocalTranscriptionReadiness();
				return Err(
					readiness.status === 'unavailable'
						? `${readiness.message} ${CHOOSE}`
						: `No local model is active on this computer. ${CHOOSE}`,
				);
			} catch (cause) {
				return Err(
					`Epicenter did not say which local model is active: ${describe(cause)}`,
				);
			}
		},

		async transcribe(audioPath, model) {
			const { data: bytes, error: readError } = await readAudio(audioPath);
			if (readError !== null)
				return Err({
					message: `The audio at '${audioPath}' could not be read: ${readError}`,
				});
			let answered: Awaited<ReturnType<typeof commands.transcribeAudioBytes>>;
			try {
				answered = await commands.transcribeAudioBytes(
					model,
					Array.from(bytes),
					{ language: null, initialPrompt: null },
				);
			} catch (cause) {
				// The command was asked and its answer never arrived.
				return Err({
					message: `Epicenter did not answer, so it is not known what came back: ${describe(cause)}. Nothing is sent again unless you try again.`,
				});
			}
			const { data: outcome, error } = answered;
			if (error !== null)
				return Err({
					message:
						error.name === 'LocalRouteUnavailable'
							? `${error.message} ${CHOOSE}`
							: `Transcription on this computer failed: ${error.message}`,
				});
			return Ok({ text: outcome.outcome === 'empty-audio' ? '' : outcome.text });
		},

		openSettings: () => commands.openHome('transcription'),
	};
}
