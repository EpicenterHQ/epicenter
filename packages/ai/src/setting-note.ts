/**
 * One note `@epicenter/ai` keeps in this computer's settings: a collection
 * with no placeholders, kept in a settings file (`settings.file(name)` from
 * `@epicenter/local`), read at once once the settings connected and written
 * whole in house style. It is not a folder's: it never syncs.
 *
 * A note that does not read never holds up the connection: `get()` answers
 * `SettingInvalid` naming the file, an action that needs it fails with that,
 * and saving a new value replaces the file (ADR-0778).
 */
import {
	type Collection,
	type FieldsOf,
	type NoteOf,
	noteText,
	readNoteText,
} from '@epicenter/definition/contract';
import type { SettingsFile } from '@epicenter/local';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

export const SettingError = defineErrors({
	/** A settings file this computer keeps does not read; saving a new value replaces it. */
	Invalid: ({ file, reason }: { file: string; reason: string }) => ({
		message: `${file} on this computer does not read (${reason}); saving a new value replaces it.`,
		file,
		reason,
	}),
});
export type SettingError = InferErrors<typeof SettingError>;

/** A setting note kept on this computer. */
export type SettingNote<TCollection extends Collection> = {
	/** The settings file's name. */
	readonly file: string;
	/**
	 * The note, null when there is none, or `SettingError.Invalid` naming the
	 * file when it does not read. Throws `SettingsNotOpen` before the settings
	 * connected.
	 */
	get(): Result<NoteOf<TCollection> | null, SettingError>;
	/** Replace the file with a note of `fields` (and `body`, empty when absent), answering once it landed. */
	set(fields: FieldsOf<TCollection> & { body?: string }): Promise<void>;
	/** Call `listener` when `get()` may answer differently; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
};

/** The note of `collection`, whose path names no placeholder, kept in `file`. */
export function settingNote<TCollection extends Collection>(
	collection: TCollection,
	file: SettingsFile,
): SettingNote<TCollection> {
	type Read = Result<NoteOf<TCollection> | null, SettingError>;
	/** The last text read, and what it read as, so a read parses once per change. */
	let last: { text: string | null; read: Read } | null = null;

	return {
		file: file.name,
		get() {
			const text = file.text();
			if (last !== null && last.text === text) return last.read;
			let read: Read = Ok(null);
			if (text !== null) {
				const note = readNoteText(collection, text);
				read =
					note.error === null
						? Ok({
								...note.data.fields,
								body: note.data.body,
							} as NoteOf<TCollection>)
						: Err(
								SettingError.Invalid({
									file: file.name,
									reason: note.error.message,
								}).error,
							);
			}
			last = { text, read };
			return read;
		},
		async set({ body = '', ...fields }) {
			const text = noteText(collection, {
				...fields,
				body,
			} as NoteOf<TCollection>);
			if (text.error !== null)
				throw new Error(
					`${file.name} cannot be written: ${text.error.message}`,
					{ cause: text.error },
				);
			await file.write(text.data);
		},
		subscribe: (listener) => file.subscribe(listener),
	};
}
