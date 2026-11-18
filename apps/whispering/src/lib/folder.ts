/**
 * Whispering's folder (ADR-0894): its notes, each recording's audio beside
 * its note, and `settings.md`, over one `Files` that `app.ts` chose (the
 * data folder on the desktop, the Origin Private File System in a browser,
 * memory in tests). Nothing here knows which, and nothing here is Svelte:
 * the query layer (`folder-query.ts`) reads it and the pages observe that.
 *
 * `read()` answers the whole folder as one snapshot: each kind's notes
 * (`notes.ts`), the recordings' audio, and the settings. Every write
 * answers a `Result`, and a note is never replaced when it changed since it
 * was read.
 *
 * A recording is its id, found from its note or its audio: audio with no
 * note lists as an untitled recording dated from its id, and a note with no
 * audio stays a recording.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';
import type { Entry, Files, FilesError } from './files/files.js';
import { NOTES } from './format/folder.js';
import { timeOf } from './format/ids.js';
import {
	createNotes,
	type NoteListing,
	type NoteOf,
	type NoteWriteError,
} from './notes.js';
import {
	createSettings,
	NO_SETTINGS,
	type SettingsSnapshot,
} from './settings.js';

type Collections = typeof NOTES;

/** The kinds of note with an id, by name. */
export type NoteName = keyof Collections;

/** A note of `name` as the lists show it: its fields and body. */
type Listed<TName extends NoteName> = NoteOf<Collections[TName]>;
export type RecordingNote = Listed<'recordings'>;
export type TranscriptionNote = Listed<'transcriptions'>;
export type TransformationNote = Listed<'transformations'>;
export type TransformationRunNote = Listed<'transformation_runs'>;
export type TextRunNote = Listed<'text_runs'>;

export type { InvalidNote } from './notes.js';

/** One note: its kind and id. */
export type NoteRef = {
	readonly collection: NoteName;
	readonly id: string;
};

/** A note's file, `<collection>/<id>.md`. */
export const notePath = ({ collection, id }: NoteRef) =>
	`${collection}/${id}.md`;

/** A title, or the id when the title is empty. */
export function titleOf(note: { readonly id: string; readonly title: string }) {
	return note.title.trim() === '' ? note.id : note.title;
}

/** Why a note does not read, in a line. */
export const describeIssues = (
	issues: readonly { field: string; message: string }[],
) =>
	issues
		.map(({ field, message }) => (field ? `${field}: ${message}` : message))
		.join('; ');

/** One audio file a recording has. */
export type AudioFile = {
	readonly id: string;
	readonly ext: string;
	/** Its size in bytes. */
	readonly size: number;
	/** When it last changed, which dates a recording that has no note. */
	readonly modifiedMs: number;
};

/** Whether a recording's audio can be read. */
export type RecordingAudio =
	| { readonly kind: 'here'; readonly file: AudioFile }
	/** No audio file has the recording's id. */
	| { readonly kind: 'absent' }
	/** More than one audio file shares the recording's id. */
	| { readonly kind: 'ambiguous'; readonly exts: readonly string[] };

/** A recording's audio, read. */
export type AudioBytes = {
	readonly bytes: Uint8Array;
	readonly ext: string;
	/** The file's name, `<id>.<ext>`, as a transcription request names it. */
	readonly name: string;
	readonly mimeType: string;
};

/** The whole folder as one read answered it. */
export type FolderSnapshot = {
	readonly [K in NoteName]: NoteListing<Collections[K]>;
} & {
	/** Every audio file in `recordings/`. */
	readonly audio: readonly AudioFile[];
	readonly settings: SettingsSnapshot;
};

const NO_NOTES = { items: [], invalid: [], texts: {} } as const;

/** The folder before its first read answers: nothing in it. */
export const EMPTY_FOLDER: FolderSnapshot = {
	recordings: NO_NOTES,
	transcriptions: NO_NOTES,
	transformations: NO_NOTES,
	transformation_runs: NO_NOTES,
	text_runs: NO_NOTES,
	audio: [],
	settings: NO_SETTINGS,
};

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Newest first by `at`, then by id (ids sort by when they were made). */
export const newest =
	<T extends { id: string }>(at: (item: T) => string) =>
	(a: T, b: T) =>
		byText(at(b), at(a)) || byText(b.id, a.id);

/** Transformations by title, as a person reads them, then by id. */
export const byTitle = (a: TransformationNote, b: TransformationNote) =>
	(a.title || a.id).localeCompare(b.title || b.id, undefined, {
		sensitivity: 'base',
	}) || byText(a.id, b.id);

/** The directory recordings and their audio are in. */
const RECORDINGS = 'recordings';

/** The audio file a listed file in `recordings/` is, or null for a note or anything else. */
function audioFileOf({ name, size, modifiedMs }: Entry): AudioFile | null {
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return null;
	const ext = name.slice(dot + 1);
	if (ext === 'md' || audioMimeTypeOf(name) === undefined) return null;
	return { id: name.slice(0, dot), ext, size, modifiedMs };
}

/** When a recording with no note was recorded: its id's time, else its audio's. */
const recordedAtOf = ({ id, modifiedMs }: AudioFile) =>
	(timeOf(id) ?? new Date(modifiedMs)).toISOString();

/** Where recording `id`'s audio is in `snapshot`. */
export function audioOf(
	snapshot: Pick<FolderSnapshot, 'audio'>,
	id: string,
): RecordingAudio {
	const playable = snapshot.audio.filter((file) => file.id === id);
	const [file, ...more] = playable;
	if (file !== undefined && more.length === 0) return { kind: 'here', file };
	if (file !== undefined)
		return { kind: 'ambiguous', exts: playable.map(({ ext }) => ext).sort() };
	return { kind: 'absent' };
}

/** Recordings in `snapshot` whose audio has no note, each as an untitled recording dated from its id. */
export function unnotedOf(
	snapshot: Pick<FolderSnapshot, 'audio' | 'recordings'>,
): RecordingNote[] {
	const noted = new Set<string>();
	for (const note of snapshot.recordings.items) noted.add(note.id);
	for (const note of snapshot.recordings.invalid) noted.add(note.id);
	const out: RecordingNote[] = [];
	for (const file of snapshot.audio) {
		if (noted.has(file.id)) continue;
		noted.add(file.id);
		out.push({
			id: file.id,
			title: '',
			recordedAt: recordedAtOf(file),
			body: '',
		});
	}
	return out;
}

/** How many bytes of audio `snapshot` holds. */
export const audioSizeOf = (snapshot: Pick<FolderSnapshot, 'audio'>) =>
	snapshot.audio.reduce((total, { size }) => total + size, 0);

/** Whispering's folder over `files`. */
export function openFolder(files: Files) {
	const notes = {
		recordings: createNotes(files, NOTES.recordings),
		transcriptions: createNotes(files, NOTES.transcriptions),
		transformations: createNotes(files, NOTES.transformations),
		transformation_runs: createNotes(files, NOTES.transformation_runs),
		text_runs: createNotes(files, NOTES.text_runs),
	};
	const settings = createSettings(files);

	async function listAudio(): Promise<Result<AudioFile[], FilesError>> {
		const listed = await files.list(RECORDINGS);
		if (listed.error !== null) return Err(listed.error);
		return Ok(listed.data.flatMap((entry) => audioFileOf(entry) ?? []));
	}

	/** Delete recording `id`'s audio files, as listed now. */
	async function deleteAudio({
		id,
	}: {
		id: string;
	}): Promise<Result<undefined, FilesError>> {
		const audio = await listAudio();
		if (audio.error !== null) return audio;
		for (const { ext } of audio.data.filter((file) => file.id === id)) {
			const removed = await files.remove(`${RECORDINGS}/${id}.${ext}`);
			if (removed.error !== null) return Err(removed.error);
		}
		return Ok(undefined);
	}

	return {
		/** Each kind's notes. */
		notes,
		/** `settings.md`. */
		settings,
		/** Read the whole folder: every kind's notes, the audio, and `settings.md`. */
		async read(): Promise<Result<FolderSnapshot, FilesError>> {
			const listed = await files.list(RECORDINGS);
			if (listed.error !== null) return Err(listed.error);
			const [
				recordings,
				transcriptions,
				transformations,
				transformation_runs,
				text_runs,
				read,
			] = await Promise.all([
				notes.recordings.list(listed.data),
				notes.transcriptions.list(),
				notes.transformations.list(),
				notes.transformation_runs.list(),
				notes.text_runs.list(),
				settings.read(),
			]);
			for (const result of [
				recordings,
				transcriptions,
				transformations,
				transformation_runs,
				text_runs,
				read,
			])
				if (result.error !== null) return Err(result.error);
			return Ok({
				recordings: recordings.data!,
				transcriptions: transcriptions.data!,
				transformations: transformations.data!,
				transformation_runs: transformation_runs.data!,
				text_runs: text_runs.data!,
				settings: read.data!,
				audio: listed.data.flatMap((entry) => audioFileOf(entry) ?? []),
			});
		},
		/** The bytes of `file`, a recording's audio. */
		async readAudio(file: AudioFile): Promise<Result<AudioBytes, string>> {
			const name = `${file.id}.${file.ext}`;
			const read = await files.read(`${RECORDINGS}/${name}`);
			if (read.error !== null) return Err(read.error.message);
			if (read.data === null)
				return Err('This recording’s audio is no longer there.');
			return Ok({
				bytes: read.data,
				ext: file.ext,
				name,
				mimeType:
					audioMimeTypeOf(`x.${file.ext}`) ?? 'application/octet-stream',
			});
		},
		deleteAudio,
		/**
		 * Delete the audio of every recording made before `cutoff`, as the
		 * person asks in Settings; nothing deletes audio on its own. A
		 * recording whose audio has no note gets its note first, so it stays
		 * listed. Answers how many recordings lost their audio, or the first
		 * failure, which stops it.
		 */
		async deleteAudioBefore({
			cutoff,
		}: {
			cutoff: Date;
		}): Promise<Result<number, FilesError | NoteWriteError>> {
			const before = cutoff.toISOString();
			const listed = await files.list(RECORDINGS);
			if (listed.error !== null) return Err(listed.error);
			const noted = await notes.recordings.list(listed.data);
			if (noted.error !== null) return Err(noted.error);
			const byId = new Map(noted.data.items.map((note) => [note.id, note]));
			const invalid = new Set(noted.data.invalid.map(({ id }) => id));
			const audio = listed.data.flatMap((entry) => audioFileOf(entry) ?? []);
			const old = new Map<string, AudioFile>();
			for (const file of audio)
				if ((byId.get(file.id)?.recordedAt ?? recordedAtOf(file)) < before)
					old.set(file.id, file);
			for (const [id, file] of old) {
				if (!byId.has(id) && !invalid.has(id)) {
					const made = await notes.recordings.set({
						id,
						seen: null,
						changes: { title: '', recordedAt: recordedAtOf(file) },
					});
					if (made.error !== null) return Err(made.error);
				}
				const deleted = await deleteAudio({ id });
				if (deleted.error !== null) return Err(deleted.error);
			}
			return Ok(old.size);
		},
	};
}

export type WhisperingFolder = ReturnType<typeof openFolder>;
