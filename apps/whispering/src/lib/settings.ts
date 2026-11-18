/**
 * The person's settings: `settings.md` at the top of Whispering's folder
 * (ADR-0894). Its front matter holds the transcription model, each provider
 * connection without its key, and the desktop's global shortcut, which a
 * browser ignores. It moves and exports with the recordings; Whispering
 * alone reads and writes it.
 *
 * `get()` reads it; `set(patch)` rewrites only the lines of the keys it
 * names over the file as it is now, so what another program wrote to the
 * other keys and the body stays (`noteAt`). Nothing is kept between calls.
 * A `settings.md` that does not read is named (`problem`), its values are
 * not used, and the next `set` replaces it.
 */
import type { ConnectionRecord, ModelChoice } from '@epicenter/ai';
import type { Static } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Files, FilesError } from './files/files.js';
import { SETTINGS } from './format/folder.js';
import { noteAt } from './notes.js';

/** The jobs a model is chosen for. */
export type Job = 'transcribe';

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
	/** Its front matter; empty when there is no file, or it does not read. */
	readonly fields: SettingsFields;
	/** Why it does not read, or null. */
	readonly problem: string | null;
};

/** The settings when there is no `settings.md`. */
export const NO_SETTINGS: SettingsSnapshot = { fields: {}, problem: null };

/** The choice for `job` in `settings`, or why there is none. */
export function chosenIn(
	settings: SettingsSnapshot,
	job: Job,
): Result<ModelChoice, ChoiceError> {
	if (settings.problem !== null)
		return ChoiceError.Invalid({ reason: settings.problem });
	const choice = settings.fields.models?.[job];
	if (choice === undefined) return ChoiceError.NoChoice({ job });
	return Ok({ endpoint: choice.endpoint, model: choice.model });
}

/** The global shortcut `settings` names, in the global-shortcut plugin's spelling. */
export const shortcutIn = (settings: SettingsSnapshot): string =>
	settings.fields.shortcut ?? DEFAULT_SHORTCUT;

/** The connections `settings` holds, as `@epicenter/ai` keeps them. */
export const connectionsIn = (
	settings: SettingsSnapshot,
): readonly ConnectionRecord[] =>
	(settings.fields.connections ?? []) as readonly ConnectionRecord[];

/** `settings.md` in `files`. */
export function createSettings(files: Files) {
	const file = noteAt(files, SETTINGS.path, SETTINGS.fields);
	return {
		/** Read `settings.md`. */
		async get(): Promise<Result<SettingsSnapshot, FilesError>> {
			const read = await file.get();
			if (read.error !== null) return Err(read.error);
			const now = read.data;
			if (now.kind === 'none') return Ok(NO_SETTINGS);
			if (now.kind === 'note') return Ok({ fields: now.fields, problem: null });
			return Ok({
				fields: {},
				problem: now.issues.map(({ message }) => message).join('; '),
			});
		},
		/**
		 * Give the keys `patch` names these values (`undefined` removes one),
		 * over `settings.md` as it is now; a `settings.md` that does not read
		 * is replaced by one holding `patch`.
		 */
		set: (patch: Partial<SettingsFields>) =>
			file.set({ fields: patch, invalid: 'replace' }),
	};
}
