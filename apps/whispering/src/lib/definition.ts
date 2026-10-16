import { type CreateRowOf, defineTable, field } from '@epicenter/definition';
import { defineFolder } from '@epicenter/folder';

/** Where recordings' audio is written: one machine's files, never committed. */
export const AUDIO = 'audio';

/**
 * Whispering's folder: each recording is `recordings/<id>.md` with its
 * metadata in frontmatter and notes in the Markdown body. The row names its
 * audio in `audioPath`, a file under `audio/`; the audio is an ordinary file the table does not own,
 * so nothing is inferred from a file that happens to share the row's stem.
 * The row is written when the recording starts and holds facts only: when it
 * started, where its audio is, and, once it stops, how long it is. Whether a
 * recording is running is never written (ADR-0542).
 * Each transcription result is its own row in `transcriptions/`, naming the
 * recording it was made from, with the transcript as its body.
 *
 * A recipe is a reusable title and instructions: `transformations/<id>.md`
 * with its title in frontmatter and the instructions as its body. Where its
 * requests go is the device's text connection, never the file. A recipe may
 * name a model to use instead of the connection's, and a recipe written by an
 * earlier build may name an endpoint, which is kept as a constraint: it runs
 * only while the text connection is that endpoint. `null` or empty in either
 * field means "use the connection's".
 *
 * Applying a recipe to a transcript writes a new row in `transformation_runs/`
 * naming the recording, transcription, and recipe it came from. Applying one
 * to pasted text writes a new row in `text_runs/`, which names no recording.
 * Both carry the instructions and input text that were sent, with the output
 * as the body, so they still read correctly after anything they came from
 * changes or is deleted. The transcription row is never written.
 *
 * An earlier build saved the transcription endpoint and model in `kv.json`.
 * It is an ordinary file now: this build reads it, to offer them when the
 * transcription connection is set up (`earlierTranscriptionOf`), and never
 * writes it; no request goes to them.
 *
 * Audio stays on the machine that recorded it: `local` names `audio/`, so no
 * commit carries it and Sync sends the rows alone (ADR-0577). Where the
 * audio a row names is not in the folder, the app says so.
 *
 * The file stem is a row's identity. A recording's title is a field, so
 * renaming a recording never moves a file or breaks a result's `recordingId`.
 *
 * This module names only the inert vocabulary. It names no folder: each
 * workspace opens `WHISPERING_FOLDER_ID`. `defineFolder` checks and prepares
 * the definition here, where it is written, so the openers and `parseRow` read
 * rows through the same prepared fields without opening anything.
 */
export const whisperingDefinition = defineFolder({
	title: 'Whispering',
	local: [`${AUDIO}/`],
	tables: {
		recordings: defineTable({
			fields: {
				title: field.string(),
				/** When the recording started. */
				recordedAt: field.instant(),
				/**
				 * Written when the recording stops. A recording a quit or a crash cut
				 * off has none; its audio is still in the folder up to the cut.
				 */
				durationMs: field.optional(field.number()),
				/** Where the audio came from, so fixture audio is never mistaken for a microphone take. */
				capture: field.select(['microphone', 'fixture']),
				/**
				 * The folder-relative path of the audio file, such as
				 * `audio/20260102-030405-k3f9.wav`. A row without it has no
				 * audio the app will play, transcribe, or name.
				 */
				audioPath: field.string(),
			},
		}),
		transcriptions: defineTable({
			fields: {
				recordingId: field.string(),
				createdAt: field.instant(),
				model: field.string(),
				endpoint: field.string(),
			},
		}),
		transformations: defineTable({
			fields: {
				title: field.string(),
				/**
				 * A chat model to use instead of the text connection's, such as
				 * `gpt-4o-mini`. `null` or empty uses the connection's model.
				 */
				model: field.nullable(field.string()),
				/**
				 * Written by an earlier build, which sent requests here. Kept as a
				 * constraint, never as a destination: the recipe runs only while the
				 * text connection is exactly this base URL. `null` or empty is none.
				 */
				endpoint: field.nullable(field.string()),
			},
		}),
		// A table name is one bare identifier, so the folder cannot be `transformation-runs`.
		transformation_runs: defineTable({
			fields: {
				recordingId: field.string(),
				transcriptionId: field.string(),
				transformationId: field.string(),
				/** The transformation's title when it ran. */
				transformationTitle: field.string(),
				createdAt: field.instant(),
				model: field.string(),
				endpoint: field.string(),
				/** The prompt that was sent, exactly. */
				prompt: field.string(),
				/** The transcript text that was sent, exactly. */
				input: field.string(),
			},
		}),
		/** Results of a recipe applied to pasted text. They name no recording. */
		text_runs: defineTable({
			fields: {
				transformationId: field.string(),
				/** The recipe's title when it ran. */
				transformationTitle: field.string(),
				createdAt: field.instant(),
				model: field.string(),
				/** The text connection's base URL the request went to. */
				endpoint: field.string(),
				/** The instructions that were sent, exactly. */
				prompt: field.string(),
				/** The pasted text that was sent, exactly. */
				input: field.string(),
			},
		}),
	},
});

export type CaptureSource = 'microphone' | 'fixture';

export type RecordingFields = CreateRowOf<
	typeof whisperingDefinition.tables.recordings
>;
export type TranscriptionFields = CreateRowOf<
	typeof whisperingDefinition.tables.transcriptions
>;
export type TransformationFields = CreateRowOf<
	typeof whisperingDefinition.tables.transformations
>;
export type TransformationRunFields = CreateRowOf<
	typeof whisperingDefinition.tables.transformation_runs
>;
export type TextRunFields = CreateRowOf<
	typeof whisperingDefinition.tables.text_runs
>;
/** Where an earlier build saved the transcription endpoint and model. */
export const EARLIER_SETTINGS_PATH = 'kv.json';

/** The transcription endpoint and model an earlier build saved. */
export type EarlierTranscription = {
	readonly baseUrl?: string;
	readonly model?: string;
};

/**
 * The transcription endpoint and model in the text of an earlier build's
 * `kv.json`, each only when it is a string. No text, or text that is not a
 * JSON object, offers nothing.
 */
export function earlierTranscriptionOf(
	text: string | undefined,
): EarlierTranscription {
	if (text === undefined) return {};
	let saved: unknown;
	try {
		saved = JSON.parse(text.replace(/^\uFEFF/, ''));
	} catch {
		return {};
	}
	if (typeof saved !== 'object' || saved === null || Array.isArray(saved))
		return {};
	const { transcriptionBaseUrl: baseUrl, transcriptionModel: model } =
		saved as Record<string, unknown>;
	return {
		...(typeof baseUrl === 'string' ? { baseUrl } : {}),
		...(typeof model === 'string' ? { model } : {}),
	};
}

export const RECORDINGS = 'recordings';
export const TRANSCRIPTIONS = 'transcriptions';
export const TRANSFORMATIONS = 'transformations';
export const TRANSFORMATION_RUNS = 'transformation_runs';
export const TEXT_RUNS = 'text_runs';

/** Where the transcription connection's form starts. Nothing is sent there until it is saved. */
export const DEFAULT_TRANSCRIPTION_CONNECTION = {
	baseUrl: 'https://api.openai.com/v1',
	model: 'whisper-1',
} as const;

/**
 * Where a new recording's audio is written, without its extension: the
 * capture adds the one its bytes call for. An existing row's audio is
 * whatever its `audioPath` says.
 */
export function recordingAudioStem(id: string): string {
	return `${AUDIO}/${id}`;
}

/**
 * The audio a recording row names, or undefined when it names none. A row
 * written before `audioPath` existed names none: it is listed as needing
 * repair, and no file is guessed from its stem.
 */
export function audioPathIn(
	fields: Readonly<Partial<RecordingFields>>,
): string | undefined {
	const path = fields.audioPath;
	return typeof path === 'string' && path !== '' ? path : undefined;
}

/**
 * Prompts offered as explicit "create" buttons. Nothing is written to the
 * folder until one is pressed, and the file it creates is an ordinary
 * transformation the person can edit or delete.
 */
export const STARTER_TRANSFORMATIONS: readonly {
	readonly title: string;
	readonly prompt: string;
}[] = [
	{
		title: 'Clean up',
		prompt:
			'You clean up dictated text. Fix punctuation, capitalization, and obvious transcription mistakes. Remove filler words and false starts. Keep the speaker’s wording and meaning. Answer with the cleaned text only.\n',
	},
	{
		title: 'Summarize',
		prompt:
			'You summarize transcripts. Write a short summary of the main points as a bulleted list, then list any action items. Use only what the transcript says. Answer with the summary only.\n',
	},
	{
		title: 'Draft an email',
		prompt:
			'You turn dictated notes into an email. Write a clear, polite email with a subject line, a greeting, short paragraphs, and a sign-off. Do not invent facts that are not in the notes. Answer with the email only.\n',
	},
];
