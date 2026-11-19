/**
 * The person's settings, in `settings.json`: the transcription server, when
 * one is set, and the microphone, when they chose one over the system
 * default. One document, read and replaced whole.
 *
 * `{ "baseUrl": ..., "model": ..., "microphone": ... }`, each optional. A
 * microphone's id means something only on the computer that listed it.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import type { Files } from '../files/files';
import { readServer, type Server } from '../transcription-server';

const PATH = 'settings.json';

export type Settings = { server?: Server; microphone?: string };

export const SettingsError = defineErrors({
	ReadFailed: ({ cause }: { cause: unknown }) => ({
		message: `${PATH} could not be read: ${extractErrorMessage(cause)}`,
		cause,
	}),
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `${PATH} could not be saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SettingsError = InferErrors<typeof SettingsError>;

/** The settings `json` holds. A field that is missing or of the wrong kind is left unset. */
export function readSettings(json: unknown): Settings {
	const microphone =
		typeof json === 'object' &&
		json !== null &&
		'microphone' in json &&
		typeof json.microphone === 'string'
			? json.microphone
			: undefined;
	return { server: readServer(json), microphone };
}

/** `settings` as the text of `settings.json`. */
export function writeSettings({ server, microphone }: Settings): string {
	return `${JSON.stringify({ ...server, microphone }, null, '\t')}\n`;
}

export function createSettings(files: Files) {
	/** The settings kept; none set when the file is not there. */
	async function read() {
		const read = await files.readMany([PATH]);
		if (read.error) return SettingsError.ReadFailed({ cause: read.error });
		const text = read.data.get(PATH);
		if (text === undefined) return Ok<Settings>({});
		try {
			return Ok(readSettings(JSON.parse(text)));
		} catch (cause) {
			return SettingsError.ReadFailed({ cause });
		}
	}

	return {
		read,

		/**
		 * Set the fields of `change`, keeping the rest as the file holds them
		 * now; a field set to undefined is removed. Answers the settings written.
		 */
		async update(change: Partial<Settings>) {
			const before = await read();
			if (before.error) return before;
			const next = { ...before.data, ...change };
			const written = await files.write(PATH, writeSettings(next));
			if (written.error)
				return SettingsError.WriteFailed({ cause: written.error });
			return Ok(next);
		},
	};
}
