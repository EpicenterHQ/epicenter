/**
 * Whispering's folder (ADR-0894): its notes, each recording's audio beside
 * its note, and `settings.md`, over one `Files` that `app.ts` chose (the
 * data folder on the desktop, the Origin Private File System in a browser,
 * memory in tests). Nothing here knows which.
 *
 * What it shows is Svelte state that `load()` fills: at start, and again
 * when the window regains focus, since another program may write the
 * folder. A write that succeeds updates it; there is no watcher. Every
 * write answers a `Result`, and a note is never replaced when it changed
 * since it was shown (`notes.svelte.ts`).
 *
 * A recording is its id, found from its note or its audio: audio with no
 * note lists as an untitled recording dated from its id, and a note with no
 * audio stays a recording.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';
import { type Whispering, whispering } from './contract.js';
import type { Entry, Files, FilesError } from './files/files.js';
import type { InvalidNoteOf, NoteOf } from './format/contract/index.js';
import { timeOf } from './format/ids.js';
import {
	type NoteList,
	type NoteWriteError,
	noteList,
} from './notes.svelte.js';
import { openSettings } from './settings.svelte.js';

type Collections = Whispering['collections'];

/** The library's note collections, by name: a note per id. */
export type NoteName = Exclude<keyof Collections, 'audio' | 'settings'>;

/** A note of `name` as the lists show it: its fields and body. */
export type Listed<TName extends NoteName> = NoteOf<Collections[TName]>;
export type RecordingNote = Listed<'recordings'>;
export type TranscriptionNote = Listed<'transcriptions'>;
export type TransformationNote = Listed<'transformations'>;
export type TransformationRunNote = Listed<'transformation_runs'>;
export type TextRunNote = Listed<'text_runs'>;

/** A note at one of `name`'s paths that does not read, with its text. */
export type InvalidNote<TName extends NoteName> = InvalidNoteOf<
	Collections[TName]
>;

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

/** Why `audio` cannot be read, or the one file to read. */
function readable(audio: RecordingAudio): Result<AudioFile, string> {
	if (audio.kind === 'here') return Ok(audio.file);
	if (audio.kind === 'ambiguous')
		return Err(
			`More than one audio file has this recording’s id (${audio.exts.join(', ')}). Keep one.`,
		);
	return Err('This recording has no audio file.');
}

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

/** Whispering's folder over `files`. */
export function openFolder(files: Files) {
	const { collections } = whispering;
	const lists = {
		recordings: noteList(files, 'recordings', collections.recordings),
		transcriptions: noteList(
			files,
			'transcriptions',
			collections.transcriptions,
		),
		transformations: noteList(
			files,
			'transformations',
			collections.transformations,
		),
		transformation_runs: noteList(
			files,
			'transformation_runs',
			collections.transformation_runs,
		),
		text_runs: noteList(files, 'text_runs', collections.text_runs),
	};
	const settings = openSettings(files);
	/** Every audio file in `recordings/`. Replaced whole, so a read of it tracks. */
	let audio = $state.raw<readonly AudioFile[]>([]);
	/** Whether the first load has answered, and why the last failed. */
	let loaded = $state(false);
	let loadProblem = $state.raw<FilesError | null>(null);
	let loading: Promise<Result<undefined, FilesError>> | undefined;

	function audioOf(id: string): RecordingAudio {
		const playable = audio.filter((file) => file.id === id);
		const [file, ...more] = playable;
		if (file !== undefined && more.length === 0) return { kind: 'here', file };
		if (file !== undefined)
			return { kind: 'ambiguous', exts: playable.map(({ ext }) => ext).sort() };
		return { kind: 'absent' };
	}

	/** Recordings with audio and no note, each as an untitled recording dated from its id. */
	const unnoted = $derived.by(() => {
		const noted = new Set<string>();
		for (const note of lists.recordings.items()) noted.add(note.id);
		for (const note of lists.recordings.invalid()) noted.add(note.id);
		const seen = new Set<string>();
		const out: RecordingNote[] = [];
		for (const { id, modifiedMs } of audio) {
			if (noted.has(id) || seen.has(id)) continue;
			seen.add(id);
			out.push({
				id,
				title: '',
				recordedAt: (timeOf(id) ?? new Date(modifiedMs)).toISOString(),
				body: '',
			});
		}
		return out;
	});

	async function loadAll(): Promise<Result<undefined, FilesError>> {
		const listed = await files.list(RECORDINGS);
		if (listed.error !== null) return Err(listed.error);
		const results = await Promise.all([
			lists.recordings.load(listed.data),
			lists.transcriptions.load(),
			lists.transformations.load(),
			lists.transformation_runs.load(),
			lists.text_runs.load(),
			settings.load(),
		]);
		const failed = results.find((result) => result.error !== null);
		if (failed?.error) return Err(failed.error);
		audio = listed.data.flatMap((entry) => audioFileOf(entry) ?? []);
		return Ok(undefined);
	}

	/** Delete recording `id`'s audio files, as listed. */
	async function deleteAudio(
		id: string,
	): Promise<Result<undefined, FilesError>> {
		for (const { ext } of audio.filter((file) => file.id === id)) {
			const removed = await files.remove(`${RECORDINGS}/${id}.${ext}`);
			if (removed.error !== null) return Err(removed.error);
		}
		audio = audio.filter((file) => file.id !== id);
		return Ok(undefined);
	}

	/** How many bytes of audio the folder holds. */
	const audioSize = $derived(
		audio.reduce((total, { size }) => total + size, 0),
	);

	return {
		...lists,
		settings,
		/**
		 * Read the folder again: every list and `settings.md`. Loads already
		 * under way are joined, not repeated.
		 */
		load(): Promise<Result<undefined, FilesError>> {
			loading ??= loadAll().then((result) => {
				loading = undefined;
				loaded = true;
				loadProblem = result.error;
				return result;
			});
			return loading;
		},
		/** Whether the folder has been read once. */
		loaded(): boolean {
			return loaded;
		},
		/** Why the last read of the folder failed, or null. */
		loadProblem(): FilesError | null {
			return loadProblem;
		},
		/** Recordings whose audio has no note, as untitled recordings. */
		unnoted(): readonly RecordingNote[] {
			return unnoted;
		},
		/** Where recording `id`'s audio is. */
		audioOf,
		/** Recording `id`'s audio bytes. */
		async readAudio(id: string): Promise<Result<AudioBytes, string>> {
			const { data: file, error } = readable(audioOf(id));
			if (error !== null) return Err(error);
			const read = await files.read(`${RECORDINGS}/${id}.${file.ext}`);
			if (read.error !== null) return Err(read.error.message);
			if (read.data === null)
				return Err('This recording’s audio is no longer there.');
			return Ok({
				bytes: read.data,
				ext: file.ext,
				name: `${id}.${file.ext}`,
				mimeType:
					audioMimeTypeOf(`x.${file.ext}`) ?? 'application/octet-stream',
			});
		},
		/** Delete recording `id`'s audio files, as listed. */
		deleteAudio,
		/** List the recordings' audio again, as after a recording's audio is written. */
		async listAudio(): Promise<Result<undefined, FilesError>> {
			const listed = await files.list(RECORDINGS);
			if (listed.error !== null) return Err(listed.error);
			audio = listed.data.flatMap((entry) => audioFileOf(entry) ?? []);
			return Ok(undefined);
		},
		/** How many bytes of audio the folder holds, as last listed. */
		audioSize(): number {
			return audioSize;
		},
		/**
		 * Delete the audio of every recording made before `cutoff`, as the
		 * person asks in Settings; nothing deletes audio on its own. A
		 * recording whose audio has no note gets its note first, so it stays
		 * listed. Answers how many recordings lost their audio, or the first
		 * failure, which stops it.
		 */
		async deleteAudioBefore(
			cutoff: Date,
		): Promise<Result<number, FilesError | NoteWriteError>> {
			const before = cutoff.toISOString();
			const recordedAt = (id: string, modifiedMs: number) =>
				lists.recordings.get({ id })?.recordedAt ??
				(timeOf(id) ?? new Date(modifiedMs)).toISOString();
			const ids = [
				...new Set(
					audio
						.filter(({ id, modifiedMs }) => recordedAt(id, modifiedMs) < before)
						.map(({ id }) => id),
				),
			];
			for (const id of ids) {
				if (!lists.recordings.has({ id })) {
					const file = audio.find((one) => one.id === id) as AudioFile;
					const noted = await lists.recordings.set(
						{ id },
						{ title: '', recordedAt: recordedAt(id, file.modifiedMs) },
					);
					if (noted.error !== null) return Err(noted.error);
				}
				const deleted = await deleteAudio(id);
				if (deleted.error !== null) return Err(deleted.error);
			}
			return Ok(ids.length);
		},
	};
}

export type WhisperingFolder = ReturnType<typeof openFolder>;
export type NoteLists = { readonly [K in NoteName]: NoteList<Collections[K]> };
