import { type CreateRowOf, defineTable, field } from '@epicenter/definition';
import { Type } from 'typebox';

/**
 * Whispering's tables: each recording is `recordings/<id>.md` with its
 * metadata in frontmatter and notes in the Markdown body. Its audio is the
 * unique supported sibling `recordings/<id>.<extension>`; rows store no path.
 * The row is written when the recording starts and
 * holds facts only: when it started and, once it stops,
 * how long it is. Whether a recording is running is never written
 * (ADR-0542). Each transcription result is its own row in `transcriptions/`,
 * naming the recording it was made from, with the transcript as its body.
 *
 * A recipe is a reusable title and instructions: `transformations/<id>.md`
 * with its title in frontmatter and the instructions as its body. Where its
 * requests go is the device's text connection, never the file. A recipe may
 * name a model to use instead of the connection's; `null` or empty means "use
 * the connection's".
 *
 * Applying a recipe to a transcript writes a new row in `transformation_runs/`
 * naming the recording, transcription, and recipe it came from. Applying one
 * to pasted text writes a new row in `text_runs/`, which names no recording.
 * Both carry the instructions and input text that were sent, with the output
 * as the body, so they still read correctly after anything they came from
 * changes or is deleted. The transcription row is never written.
 *
 * The file stem is a row's identity. A recording's title is a field, so
 * renaming a recording never moves a file or breaks a result's `recordingId`.
 *
 * A schema only interprets (ADR-0632): a row that does not fit is listed with
 * its exact source and its issues, for repair, and a save never validates, so
 * a field another program added survives every edit.
 */
const recordings = defineTable({
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
	},
});

const transcriptions = defineTable({
	fields: {
		recordingId: field.string(),
		createdAt: field.instant(),
		model: field.string(),
		endpoint: field.string(),
	},
});

const transformations = defineTable({
	fields: {
		title: field.string(),
		/**
		 * A chat model to use instead of the text connection's, such as
		 * `gpt-4o-mini`. `null` or empty uses the connection's model.
		 */
		model: field.nullable(field.string()),
	},
});

// A table name is one bare directory, so the folder is `transformation_runs`.
const transformationRuns = defineTable({
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
});

/** Results of a recipe applied to pasted text. They name no recording. */
const textRuns = defineTable({
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
});

export type CaptureSource = 'microphone' | 'fixture';

export type RecordingFields = CreateRowOf<typeof recordings>;
export type TranscriptionFields = CreateRowOf<typeof transcriptions>;
export type TransformationFields = CreateRowOf<typeof transformations>;
export type TransformationRunFields = CreateRowOf<typeof transformationRuns>;
export type TextRunFields = CreateRowOf<typeof textRuns>;

/**
 * The tables Whispering reads, each with the schema its rows read through.
 * The layout passes them to FolderApp's opener for browser storage or the
 * directory bound to the desktop window.
 */
export const whisperingTables = {
	recordings: Type.Object(recordings.fields),
	transcriptions: Type.Object(transcriptions.fields),
	transformations: Type.Object(transformations.fields),
	transformation_runs: Type.Object(transformationRuns.fields),
	text_runs: Type.Object(textRuns.fields),
};
export type WhisperingTables = typeof whisperingTables;

export const RECORDINGS = 'recordings';
export const TRANSCRIPTIONS = 'transcriptions';
export const TRANSFORMATIONS = 'transformations';
export const TRANSFORMATION_RUNS = 'transformation_runs';
export const TEXT_RUNS = 'text_runs';

/** A row's file: `<table>/<id>.md`. */
export const rowPath = (table: string, id: string) => `${table}/${id}.md`;

/**
 * The ID of the row `path` is in `table`, or undefined when it is not one:
 * a Markdown file directly in the table's directory.
 */
export function rowIdOf(table: string, path: string): string | undefined {
	const prefix = `${table}/`;
	if (!path.startsWith(prefix) || !path.endsWith('.md')) return undefined;
	const id = path.slice(prefix.length, -'.md'.length);
	return id === '' || id.includes('/') ? undefined : id;
}

/** Where the transcription connection's form starts. Nothing is sent there until it is saved. */
export const DEFAULT_TRANSCRIPTION_CONNECTION = {
	baseUrl: 'https://api.openai.com/v1',
	model: 'whisper-1',
} as const;

/**
 * Where a new recording's audio is written, without its extension: the
 * capture adds the one its bytes call for, beside the Markdown row.
 */
export function recordingAudioStem(id: string): string {
	return `${RECORDINGS}/${id}`;
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
