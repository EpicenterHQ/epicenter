/**
 * The person's settings: `settings.md` at the top of Whispering's folder
 * (ADR-0894), as Svelte state. Its front matter holds the model for each
 * job, each provider connection without its key, and the desktop's global
 * shortcut, which a browser ignores. It moves and exports with the
 * recordings; Whispering alone reads and writes it.
 *
 * `load()` reads it, at start and when the window regains focus. A change
 * reads the file again first and, when its bytes differ from what was
 * shown, writes nothing and shows the newer settings
 * (`NoteError.Changed`). A `settings.md` that does not read is named
 * (`problem()`), its values are not used, and saving a setting replaces it.
 */
import type {
	ConnectionRecord,
	ConnectionStore,
	ModelChoice,
} from '@epicenter/ai';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type Whispering, whispering } from './contract.js';
import { decode, encode, type Files, type FilesError } from './files/files.js';
import type { FieldsOf } from './format/contract/index.js';
import { changeNote, newNote } from './format/note.js';
import {
	compiledOf,
	NoteError,
	type NoteWriteError,
	oneAtATime,
	readNote,
} from './notes.svelte.js';

export const SETTINGS_PATH = 'settings.md';

/** The jobs a model is chosen for. */
export type Job = 'transcribe' | 'chat';

/** What `settings.md` holds. */
export type SettingsFields = FieldsOf<Whispering['collections']['settings']>;

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

type Held = {
	/** The file's text as read, to tell whether it changed since; null when there is none. */
	readonly seen: string | null;
	/** Its front matter, when it reads; empty when there is no file. */
	readonly fields: SettingsFields | null;
	/** Its body, kept as it is. */
	readonly body: string;
	/** Why it does not read, or null. */
	readonly problem: string | null;
};

const NONE: Held = { seen: null, fields: {}, body: '', problem: null };

export function openSettings(files: Files) {
	const compiled = compiledOf('settings', whispering.collections.settings);
	let held = $state.raw<Held>(NONE);
	const listeners = new Set<() => void>();
	const run = oneAtATime();

	function hold(bytes: Uint8Array | null) {
		held = heldOf(bytes);
		for (const listener of [...listeners]) listener();
	}

	function heldOf(bytes: Uint8Array | null): Held {
		if (bytes === null) return NONE;
		const seen = decode(bytes);
		const read = readNote(compiled, bytes);
		if (read.kind === 'note')
			return {
				seen,
				fields: read.fields as SettingsFields,
				body: read.body,
				problem: null,
			};
		return {
			seen,
			fields: null,
			body: '',
			problem: read.issues.map(({ message }) => message).join('; '),
		};
	}

	/**
	 * Change the settings with `change`, over what `settings.md` holds now,
	 * unless it changed since it was shown.
	 */
	function update(
		change: (now: SettingsFields) => SettingsFields,
	): Promise<Result<undefined, NoteWriteError>> {
		return run(async () => {
			const read = await files.read(SETTINGS_PATH);
			if (read.error !== null) return Err(read.error);
			const now = read.data === null ? null : decode(read.data);
			if (now !== held.seen) {
				hold(read.data);
				return NoteError.Changed({ path: SETTINGS_PATH });
			}
			const before: Record<string, unknown> = held.fields ?? {};
			const after: Record<string, unknown> = change(held.fields ?? {});
			// Only the lines of the keys that changed are rewritten; one that
			// does not read is replaced whole.
			const text =
				held.seen !== null && held.problem === null
					? changeNote(
							held.seen,
							{
								...Object.fromEntries(
									Object.keys(before).map((key) => [key, undefined]),
								),
								...after,
							},
							undefined,
						)
					: newNote(after, held.body, compiled.keys);
			const bytes = encode(text);
			const written = await files.write(SETTINGS_PATH, bytes);
			if (written.error !== null) return Err(written.error);
			hold(bytes);
			return Ok(undefined);
		});
	}

	/** The choice for `job`, or why there is none. */
	function chosen(job: Job): Result<ModelChoice, ChoiceError> {
		if (held.problem !== null)
			return ChoiceError.Invalid({ reason: held.problem });
		const choice = held.fields?.models?.[job];
		if (choice === undefined) return ChoiceError.NoChoice({ job });
		return Ok({ endpoint: choice.endpoint, model: choice.model });
	}

	/** The connections in `settings.md`, as `@epicenter/ai` keeps them. */
	const connections: ConnectionStore = {
		list: () => (held.fields?.connections ?? []) as readonly ConnectionRecord[],
		problem: () =>
			held.problem === null
				? null
				: { message: `settings.md does not read (${held.problem})` },
		async save(list) {
			const saved = await update((now) => ({
				...now,
				connections: list.map((record) => ({ ...record })),
			}));
			if (saved.error !== null) throw new Error(saved.error.message);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		/** Read `settings.md` again. */
		async load(): Promise<Result<undefined, FilesError>> {
			const read = await files.read(SETTINGS_PATH);
			if (read.error !== null) return Err(read.error);
			if ((read.data === null ? null : decode(read.data)) !== held.seen)
				hold(read.data);
			return Ok(undefined);
		},
		/** Why `settings.md` does not read, or null. */
		problem(): string | null {
			return held.problem;
		},
		/** The model chosen for each job. */
		choices: {
			/** The model chosen for `job`, or null. */
			get(job: Job): ModelChoice | null {
				return chosen(job).data ?? null;
			},
			/** The model chosen for `job`, for an action that decides on it: why there is none. */
			require: chosen,
			/** Choose `choice` for `job`; replaces a `settings.md` that does not read. */
			set(job: Job, choice: ModelChoice) {
				return update((now) => ({
					...now,
					models: {
						...now.models,
						[job]: { endpoint: choice.endpoint, model: choice.model },
					},
				}));
			},
		},
		/** The connections, for `customEndpoints`. */
		connections,
		/** The global shortcut, in the global-shortcut plugin's spelling. */
		shortcut(): string {
			return held.fields?.shortcut ?? DEFAULT_SHORTCUT;
		},
		/** Make `key` the global shortcut. */
		setShortcut(key: string) {
			return update((now) => ({ ...now, shortcut: key }));
		},
		/** Call `listener` whenever the settings change; returns the unsubscribe. */
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export type Settings = ReturnType<typeof openSettings>;
