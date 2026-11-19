/**
 * What `settings.json` holds: the transcription server, when one is set, and
 * the microphone, when the person chose one over the system default. Both
 * belong to this computer; the file never leaves it.
 *
 * `{ "baseUrl": ..., "model": ..., "microphone": ... }`, each optional.
 */
import { readServer, type Server } from './transcription-server';

export type SettingsFile = { server?: Server; microphone?: string };

/** The settings `json` holds. A field that is missing or of the wrong kind is left unset. */
export function readSettings(json: unknown): SettingsFile {
	const server = readServer(json);
	const microphone =
		typeof json === 'object' &&
		json !== null &&
		'microphone' in json &&
		typeof json.microphone === 'string'
			? json.microphone
			: undefined;
	return { server, microphone };
}

/** `settings` as the text of `settings.json`. */
export function writeSettings({ server, microphone }: SettingsFile): string {
	return `${JSON.stringify({ ...server, microphone }, null, '\t')}\n`;
}
