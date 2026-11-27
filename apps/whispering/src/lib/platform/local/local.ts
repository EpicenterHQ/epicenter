/**
 * Transcription on this computer: the models that can do it, and running
 * one on a recording. Only the desktop app has it; a browser tab says so
 * through `available` and offers no models.
 *
 * A model's file lives in the shared Hugging Face cache
 * (`~/.cache/huggingface/hub`), so every app on the computer that uses the
 * same model shares one download. Removing a model removes it for them too.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/** A model Whispering can run here, and whether its file is downloaded. */
export type LocalModel = {
	/** What `settings.json` names it by (`transcription.local.model`). */
	id: string;
	name: string;
	description: string;
	sizeBytes: number;
	/** Whether it takes the dictionary's words as hints. Whisper does; Parakeet does not. */
	supportsPrompt: boolean;
	downloaded: boolean;
};

/** Why a recording got no text here, as `LocalError` in `local.rs` says it. */
export type LocalError =
	| { name: 'NoAudio'; message: string }
	| { name: 'ModelMissing'; message: string }
	| { name: 'Failed'; message: string };

export const LocalFailure = defineErrors({
	/** The command failed in a way neither `LocalError` nor the model commands name. */
	Failed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
	/** Asked of a browser tab, which has no models. */
	Unavailable: () => ({
		message: 'Only the desktop app transcribes on this computer.',
	}),
});
export type LocalFailure = InferErrors<typeof LocalFailure>;

export type Local = {
	/** Whether this is the desktop app, which can transcribe on this computer. */
	available: boolean;
	/** Every model Whispering can run here; none in a browser. */
	models(): Promise<Result<LocalModel[], LocalFailure>>;
	/**
	 * Download the model `id`, calling `onProgress` with the share received,
	 * from 0 to 1. Answers when the file is there; at once when it already is.
	 */
	download(
		id: string,
		onProgress: (share: number) => void,
	): Promise<Result<void, LocalFailure>>;
	/** Delete the model `id`'s file from the shared cache. */
	remove(id: string): Promise<Result<void, LocalFailure>>;
	/** Show the model `id`'s folder in the file manager. */
	reveal(id: string): Promise<Result<void, LocalFailure>>;
	/**
	 * The text of the recording `id`, from `model`; empty when the audio
	 * holds no sound. `prompt` reaches only a model that takes one.
	 */
	transcribe(
		id: string,
		model: string,
		prompt: string | undefined,
	): Promise<Result<string, LocalError | LocalFailure>>;
};
