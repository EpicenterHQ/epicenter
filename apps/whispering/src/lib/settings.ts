/**
 * The person's settings: `settings.md` at the top of Whispering's folder
 * (ADR-0894). Its front matter holds the model for each job, each provider
 * connection without its key, and the desktop's global shortcut, which a
 * browser ignores. It moves and exports with the recordings; Whispering
 * alone reads and writes it.
 *
 * `read()` reads it; the query layer reads it with the rest of the folder.
 * Nothing is kept between calls. A change carries the text that was shown
 * (`seen`, the snapshot's `text`), reads the file again first and, when it
 * differs, writes nothing and answers `NoteError.Changed`; the next read
 * shows the newer settings. A `settings.md` that does not read is named
 * (`problem`), its values are not used, and saving a setting replaces it.
 */
import type { ConnectionRecord, ModelChoice } from '@epicenter/ai';
import type { Static } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { decode, encode, type Files, type FilesError } from './files/files.js';
import { fieldNamesOf, SETTINGS } from './format/folder.js';
import { changeNote, newNote } from './format/note.js';
import { NoteError, type NoteWriteError, readNote } from './notes.js';

const SETTINGS_PATH = SETTINGS.path;

/** The jobs a model is chosen for. */
export type Job = 'transcribe' | 'chat';

/** What `settings.md` holds. */
export type SettingsFields = Static<typeof SETTINGS.fields>;

/** The global shortcut when `settings.md` names none. */
export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+;';

export const ChoiceError = defineErrors({
	/** No model is chosen for the job. */
	NoChoice: ({ job }: { job: Job }) => ({
		message: `Choose a model for ${job} first.`,
		job,
	}),
	/** `settings.md` does not read, so no choice in it is used. */
	Invalid: ({ reason }: { reason: string }) => ({
		message: `settings.md does not read (${reason}); choosing a model replaces it.`,
		reason,
	}),
});
export type ChoiceError = InferErrors<typeof ChoiceError>;

/** `settings.md` as read. */
export type SettingsSnapshot = {
	/** Its front matter, when it reads; empty when there is no file. */
	readonly fields: SettingsFields | null;
	/** Its body, kept as it is. */
	readonly body: string;
	/** Why it does not read, or null. */
	readonly problem: string | null;
	/** The file's text as read, which a change says it saw; null when there is no file. */
	readonly text: string | null;
};

/** The settings when there is no `settings.md`. */
export const NO_SETTINGS: SettingsSnapshot = {
	fields: {},
	body: '',
	problem: null,
	text: null,
};

function snapshotOf(bytes: Uint8Array | null): SettingsSnapshot {
	if (bytes === null) return NO_SETTINGS;
	const text = decode(bytes);
	const read = readNote(SETTINGS.fields, bytes);
	if (read.kind === 'note')
		return {
			fields: read.fields as SettingsFields,
			body: read.body,
			problem: null,
			text,
		};
	return {
		fields: null,
		body: '',
		problem: read.issues.map(({ message }) => message).join('; '),
		text,
	};
}

/** A settings change's `seen`: `settings.md`'s text as shown, or null when there was none. */
type Seen = { seen: string | null };

/** The choice for `job` in `settings`, or why there is none. */
export function chosenIn(
	settings: SettingsSnapshot,
	job: Job,
): Result<ModelChoice, ChoiceError> {
	if (settings.problem !== null)
		return ChoiceError.Invalid({ reason: settings.problem });
	const choice = settings.fields?.models?.[job];
	if (choice === undefined) return ChoiceError.NoChoice({ job });
	return Ok({ endpoint: choice.endpoint, model: choice.model });
}

/** The global shortcut `settings` names, in the global-shortcut plugin's spelling. */
export const shortcutIn = (settings: SettingsSnapshot): string =>
	settings.fields?.shortcut ?? DEFAULT_SHORTCUT;

/** The connections `settings` holds, as `@epicenter/ai` keeps them. */
export const connectionsIn = (
	settings: SettingsSnapshot,
): readonly ConnectionRecord[] =>
	(settings.fields?.connections ?? []) as readonly ConnectionRecord[];

/** `settings.md` in `files`. */
export function createSettings(files: Files) {
	const fieldNames = fieldNamesOf(SETTINGS.fields);

	/**
	 * Change the settings with `change`, over what `settings.md` holds now,
	 * unless it is not what was `seen`.
	 */
	async function update(
		seen: string | null,
		change: (now: SettingsFields) => SettingsFields,
	): Promise<Result<undefined, NoteWriteError>> {
		const read = await files.read(SETTINGS_PATH);
		if (read.error !== null) return Err(read.error);
		const now = snapshotOf(read.data);
		if (now.text !== seen) return NoteError.Changed({ path: SETTINGS_PATH });
		const before: Record<string, unknown> = now.fields ?? {};
		const after: Record<string, unknown> = change(now.fields ?? {});
		// Only the lines of the keys that changed are rewritten; one that
		// does not read is replaced whole.
		const text =
			now.text !== null && now.problem === null
				? changeNote(
						now.text,
						{
							...Object.fromEntries(
								Object.keys(before).map((key) => [key, undefined]),
							),
							...after,
						},
						undefined,
					)
				: newNote(after, now.body, fieldNames);
		const bytes = encode(text);
		const written = await files.write(SETTINGS_PATH, bytes);
		if (written.error !== null) return Err(written.error);
		return Ok(undefined);
	}

	return {
		/** Read `settings.md`. */
		async read(): Promise<Result<SettingsSnapshot, FilesError>> {
			const read = await files.read(SETTINGS_PATH);
			if (read.error !== null) return Err(read.error);
			return Ok(snapshotOf(read.data));
		},
		/** Choose `choice` for `job`; replaces a `settings.md` that does not read. */
		setChoice({ seen, job, choice }: Seen & { job: Job; choice: ModelChoice }) {
			return update(seen, (now) => ({
				...now,
				models: {
					...now.models,
					[job]: { endpoint: choice.endpoint, model: choice.model },
				},
			}));
		},
		/** Keep `connections` as the person's connections. */
		setConnections({
			seen,
			connections,
		}: Seen & {
			connections: readonly ConnectionRecord[];
		}) {
			return update(seen, (now) => ({
				...now,
				connections: connections.map((record) => ({ ...record })),
			}));
		},
		/** Make `key` the global shortcut. */
		setShortcut({ seen, key }: Seen & { key: string }) {
			return update(seen, (now) => ({ ...now, shortcut: key }));
		},
	};
}
