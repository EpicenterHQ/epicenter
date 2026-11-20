/**
 * The person's settings, in `settings.json`: the transcription server, when
 * one is set; the microphone, when they chose one over the system default;
 * and the cleanup model, when they set one up. One document, read and
 * replaced whole.
 *
 * ```json
 * { "baseUrl": ..., "model": ..., "microphone": ...,
 *   "cleanup": { "model": ..., "baseUrl": ..., "off": true } }
 * ```
 *
 * Each is optional. A microphone's id means something only on the computer
 * that listed it.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { files } from '../platform';
import { readServer, type Server } from '../transcription-server';

const PATH = 'settings.json';

/**
 * The chat model cleanup sends each transcript to. Its server is the
 * transcription server unless `baseUrl` names another, so a provider that
 * does both needs one address and one key. `off` is set only while the
 * person has turned cleanup off, so turning it back on loses nothing.
 */
export type Cleanup = { model: string; baseUrl?: string; off?: true };

export type Settings = {
	server?: Server;
	microphone?: string;
	cleanup?: Cleanup;
};

/** The server cleanup asks with `settings`, or undefined when cleanup is not set up or is off. */
export function cleanupServer({
	server,
	cleanup,
}: Settings): Server | undefined {
	if (!cleanup || cleanup.off) return undefined;
	const baseUrl = cleanup.baseUrl ?? server?.baseUrl;
	return baseUrl ? { baseUrl, model: cleanup.model } : undefined;
}

/** The cleanup settings `json` holds, or undefined when they are missing or not readable. */
function readCleanup(json: unknown): Cleanup | undefined {
	if (typeof json !== 'object' || json === null) return undefined;
	const { model, baseUrl, off } = json as Record<string, unknown>;
	if (typeof model !== 'string' || !model.trim()) return undefined;
	return {
		model,
		...(typeof baseUrl === 'string' && baseUrl.trim() ? { baseUrl } : {}),
		...(off === true ? { off } : {}),
	};
}

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
function readSettings(json: unknown): Settings {
	const microphone =
		typeof json === 'object' &&
		json !== null &&
		'microphone' in json &&
		typeof json.microphone === 'string'
			? json.microphone
			: undefined;
	const cleanup =
		typeof json === 'object' && json !== null && 'cleanup' in json
			? readCleanup(json.cleanup)
			: undefined;
	return { server: readServer(json), microphone, cleanup };
}

/** `settings` as the text of `settings.json`. */
function writeSettings({ server, microphone, cleanup }: Settings): string {
	return `${JSON.stringify({ ...server, microphone, cleanup }, null, '\t')}\n`;
}

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

export const settings = {
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
