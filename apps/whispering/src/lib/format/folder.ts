/**
 * What is in Whispering's folder (ADR-0894), and how a note is checked.
 *
 * - A recording is a note at `recordings/{id}.md` (its title, when it was
 *   recorded, and how long it is; notes in the body) beside its audio at
 *   `recordings/{id}.{ext}`: `m4a` or `webm` from a browser, `webm` from the
 *   desktop. Audio with no note is still a recording (`folder.ts`).
 * - A transcription is a note at `transcriptions/{id}.md` naming its
 *   recording, the transcript as body.
 * - `settings.md` is the person's settings: the transcription model, each
 *   provider connection and its endpoint, and the desktop's global shortcut
 *   in the global-shortcut plugin's spelling (`CommandOrControl+Shift+;`),
 *   which a browser ignores. A key and the microphone stay out of the
 *   folder (`this-computer.ts`).
 *
 * A file's id is its identity: renaming a recording changes its title,
 * never its path, so a transcript's `recordingId` never breaks.
 *
 * Each note's fields are a TypeBox object. A field is required unless it is
 * `Type.Optional`, and a key not declared is kept and never checked.
 */
import { type TObject, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { lineOf, parseNote } from './note.js';

/** An instant in UTC, to the millisecond, as `Date.prototype.toISOString` writes it. */
const instant = Type.String({
	format: 'date-time',
	pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

/** A model chosen for a job: the endpoint that offers it, and its id there. */
const choice = Type.Object({ endpoint: Type.String(), model: Type.String() });

/** Each kind of note with an id: the directory its notes are in, as `<dir>/<id>.md`, and their fields. */
export const NOTES = {
	recordings: {
		dir: 'recordings',
		fields: Type.Object({
			title: Type.String(),
			recordedAt: instant,
			durationMs: Type.Optional(Type.Number({ minimum: 0 })),
		}),
	},
	transcriptions: {
		dir: 'transcriptions',
		fields: Type.Object({
			recordingId: Type.String(),
			createdAt: instant,
			model: Type.String(),
			endpoint: Type.String(),
		}),
	},
} as const;

/** `settings.md`, at the top of the folder: every field optional. */
export const SETTINGS = {
	path: 'settings.md',
	fields: Type.Object({
		models: Type.Optional(
			Type.Object({
				transcribe: Type.Optional(choice),
			}),
		),
		connections: Type.Optional(
			Type.Array(
				Type.Object({
					id: Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' }),
					name: Type.String(),
					baseUrl: Type.String(),
					models: Type.Array(Type.String()),
					key: Type.Optional(Type.String()),
				}),
			),
		),
		shortcut: Type.Optional(Type.String()),
	}),
} as const;

/** A kind of note with an id. */
/** One reason a note does not read: the field it is about (`''` for the note as a whole), and its line when it has one. */
export type NoteIssue = {
	readonly field: string;
	readonly line?: number;
	readonly message: string;
};

/**
 * Each way `values` does not fit `fields`: a required field missing, or a
 * value of the wrong shape, each by field. A nested failure names where in
 * the value it is (`connections/0/name`).
 */
function checkFields(
	fields: TObject,
	values: Readonly<Record<string, unknown>>,
): NoteIssue[] {
	const required = new Set(fields.required ?? []);
	const issues: NoteIssue[] = [];
	for (const [field, schema] of Object.entries(fields.properties)) {
		const value = Object.hasOwn(values, field) ? values[field] : undefined;
		if (value === undefined) {
			if (required.has(field))
				issues.push({ field, message: `${field} is missing` });
			continue;
		}
		for (const error of Value.Errors(schema, value))
			issues.push({
				field,
				message: `${field}${error.instancePath} does not conform: ${error.message}`,
			});
	}
	return issues;
}

/**
 * `text` read as a note with `fields`: its fields and body, or every reason
 * it does not read, each at its line when it has one. Front matter that
 * does not parse is one reason; otherwise each field that does not fit is
 * one.
 */
export function checkNote(
	fields: TObject,
	text: string,
): Result<{ fields: Record<string, unknown>; body: string }, NoteIssue[]> {
	const parsed = parseNote(text);
	if (parsed.error !== null) {
		const { field, line, reason } = parsed.error;
		return Err([
			{
				field: field ?? '',
				...(line === undefined ? {} : { line }),
				message: reason,
			},
		]);
	}
	const issues = checkFields(fields, parsed.data.fields);
	if (issues.length > 0)
		return Err(
			issues.map((issue) => {
				const line = lineOf(text, issue.field);
				return line === undefined ? issue : { ...issue, line };
			}),
		);
	return Ok({ fields: { ...parsed.data.fields }, body: parsed.data.body });
}

/** The fields `fields` declares, in its order: a new note writes them first. */
export const fieldNamesOf = (fields: TObject): readonly string[] =>
	Object.keys(fields.properties);
