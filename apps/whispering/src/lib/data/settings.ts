/**
 * The person's settings, in `settings.json`: one flat object, one key per
 * setting, each with a default. `SCHEMA` is the one place a setting is
 * defined; the `Settings` type and the defaults come from it.
 *
 * ```json
 * {
 * 	"transcription.provider": "server",
 * 	"transcription.local.model": "...",
 * 	"transcription.server.baseUrl": "https://api.openai.com/v1",
 * 	"transcription.server.model": "whisper-1",
 * 	"microphone": null,
 * 	"cleanup.enabled": false,
 * 	"cleanup.baseUrl": "",
 * 	"cleanup.model": ""
 * }
 * ```
 *
 * No key is ever missing from what `read` answers: a file that is not
 * there, or a value of the wrong kind, reads as that key's default. So
 * "not set up" is never a missing key; it is an empty address or model,
 * which `transcriber` and `cleanupServer` work out.
 */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { files } from '../platform';
import type { Server } from '../transcription-server';

const PATH = 'settings.json';

const SCHEMA = Type.Object({
	/** Which of the two below transcribes a take. */
	'transcription.provider': Type.Union(
		[Type.Literal('local'), Type.Literal('server')],
		{ default: 'local' },
	),
	/** The on-device model's id, as the model catalog names it. Parakeet until another is chosen. */
	'transcription.local.model': Type.String({
		default:
			'handy-computer/parakeet-tdt-0.6b-v3-gguf@main/parakeet-tdt-0.6b-v3-Q4_K_M.gguf',
	}),
	/** The OpenAI-compatible server's address; empty until one is saved. */
	'transcription.server.baseUrl': Type.String({ default: '' }),
	'transcription.server.model': Type.String({ default: '' }),
	/**
	 * The microphone's id, or null for the system default. An id means
	 * something only on the computer that listed it.
	 */
	microphone: Type.Union([Type.String(), Type.Null()], { default: null }),
	/** Whether each transcript goes to the cleanup model. Off keeps the model saved. */
	'cleanup.enabled': Type.Boolean({ default: false }),
	/**
	 * The cleanup model's server. Empty means the transcription server, so
	 * a provider that does both needs one address and one key.
	 */
	'cleanup.baseUrl': Type.String({ default: '' }),
	/** The chat model cleanup sends each transcript to; empty until one is saved. */
	'cleanup.model': Type.String({ default: '' }),
});

export type Settings = Static<typeof SCHEMA>;

/** Every setting at its default: what a fresh install reads. */
export const DEFAULTS = Value.Default(SCHEMA, {}) as Settings;

/** What transcribes a take: a model on this computer, or a server. */
export type Transcriber =
	| { kind: 'local'; model: string }
	| ({ kind: 'server' } & Server);

/** What transcribes a take with `settings`, or undefined when the chosen provider is not filled in. */
export function transcriber(settings: Settings): Transcriber | undefined {
	if (settings['transcription.provider'] === 'local') {
		const model = settings['transcription.local.model'];
		return model ? { kind: 'local', model } : undefined;
	}
	const baseUrl = settings['transcription.server.baseUrl'];
	const model = settings['transcription.server.model'];
	return baseUrl && model ? { kind: 'server', baseUrl, model } : undefined;
}

/** The server cleanup asks with `settings`, or undefined when cleanup is off or not filled in. */
export function cleanupServer(settings: Settings): Server | undefined {
	const model = settings['cleanup.model'];
	if (!settings['cleanup.enabled'] || !model) return undefined;
	const baseUrl =
		settings['cleanup.baseUrl'] || settings['transcription.server.baseUrl'];
	return baseUrl ? { baseUrl, model } : undefined;
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

/**
 * The settings `json` holds. Each key is checked on its own, so a missing
 * or mistyped value costs that one setting and no other.
 */
export function readSettings(json: unknown): Settings {
	const held: Record<string, unknown> =
		typeof json === 'object' && json !== null ? { ...json } : {};
	return Object.fromEntries(
		Object.entries(SCHEMA.properties).map(([key, schema]) => [
			key,
			Value.Check(schema, held[key])
				? held[key]
				: DEFAULTS[key as keyof Settings],
		]),
	) as Settings;
}

/** The settings kept; every default when the file is not there. */
async function read() {
	const read = await files.readMany([PATH]);
	if (read.error) return SettingsError.ReadFailed({ cause: read.error });
	const text = read.data.get(PATH);
	if (text === undefined) return Ok(DEFAULTS);
	try {
		return Ok(readSettings(JSON.parse(text)));
	} catch (cause) {
		return SettingsError.ReadFailed({ cause });
	}
}

export const settings = {
	read,

	/**
	 * Set the keys of `change`, keeping the rest as the file holds them
	 * now. Answers the settings written.
	 */
	async update(change: Partial<Settings>) {
		const before = await read();
		if (before.error) return before;
		const next = { ...before.data, ...change };
		const written = await files.write(
			PATH,
			`${JSON.stringify(next, null, '\t')}\n`,
		);
		if (written.error)
			return SettingsError.WriteFailed({ cause: written.error });
		return Ok(next);
	},
};
