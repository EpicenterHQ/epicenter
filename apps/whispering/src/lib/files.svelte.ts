/**
 * Whispering's files over one contract client: the note lists, and each
 * recording's audio beside them. The web build hands in this browser's
 * device (opened by `routes/components/Startup.svelte`); which client it
 * is is the variant root's choice, never this module's, so another variant
 * passes its own.
 *
 * Reads are Svelte state: each list lists and listens only while something
 * reactive reads it. Writes answer a `Result`; the caller presents failures.
 */
import type {
	Client,
	InvalidNoteOf,
	NoteOf,
	Version,
} from '@epicenter/definition/contract';
import { fromClient, type ReactiveNotes } from '@epicenter/svelte/client';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';
import type { Whispering } from './contract.js';

type Collections = Whispering['collections'];

/** The note collections, by name. */
export type NoteName = Exclude<keyof Collections, 'audio'>;

/** A note of `name` as the lists show it: its fields, body and version. */
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
	/** Its version as listed. */
	readonly version: Version;
};

/** Whether a recording's audio can be read. */
export type RecordingAudio =
	/** Nothing has been listed yet. */
	| { readonly kind: 'listing' }
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

/** A finished recording, to keep. */
export type NewRecording = {
	readonly id: string;
	readonly title: string;
	readonly recordedAt: string;
	readonly durationMs: number;
	readonly capture: 'microphone' | 'fixture';
	readonly ext: string;
	readonly bytes: Uint8Array;
};

/** Each note collection, as the pages read it. */
export type NoteLists = {
	readonly [K in NoteName]: ReactiveNotes<Collections[K]>;
};

/** Whispering's files: the note lists, and the recordings' audio. */
export type WhisperingFiles = NoteLists & {
	/** Where recording `id`'s audio is, read reactively. */
	audioOf(id: string): RecordingAudio;
	/** Recording `id`'s audio bytes. */
	readAudio(id: string): Promise<Result<AudioBytes, string>>;
	/** Delete recording `id`'s audio files, over the versions listed. */
	deleteAudio(id: string): Promise<Result<void, string>>;
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
	if (audio.kind === 'listing')
		return Err('This recording’s audio has not been listed yet.');
	return Err('This recording has no audio file.');
}

/** Whispering's files over `client`, which every page reads and edits. */
export function filesOf(client: Client<Whispering>): WhisperingFiles {
	const files = fromClient(client);
	const { audio } = files;

	function audioOf(id: string): RecordingAudio {
		const playable = audio.items.filter(
			(file) =>
				file.id === id && audioMimeTypeOf(`x.${file.ext}`) !== undefined,
		);
		const [file, ...more] = playable;
		if (file !== undefined && more.length === 0)
			return {
				kind: 'here',
				file: { id, ext: file.ext, version: file.version },
			};
		if (file !== undefined)
			return { kind: 'ambiguous', exts: playable.map(({ ext }) => ext).sort() };
		return audio.loading ? { kind: 'listing' } : { kind: 'absent' };
	}

	return {
		recordings: files.recordings,
		transcriptions: files.transcriptions,
		transformations: files.transformations,
		transformation_runs: files.transformation_runs,
		text_runs: files.text_runs,
		audioOf,
		async readAudio(id) {
			const { data: file, error } = readable(audioOf(id));
			if (error !== null) return Err(error);
			const read = await client.audio.get({ id, ext: file.ext });
			if (read.error !== null) return Err(read.error.message);
			return Ok({
				bytes: read.data.bytes,
				ext: file.ext,
				name: `${id}.${file.ext}`,
				mimeType:
					audioMimeTypeOf(`x.${file.ext}`) ?? 'application/octet-stream',
			});
		},
		async deleteAudio(id) {
			for (const { ext } of audio.items.filter((file) => file.id === id)) {
				const deleted = await audio.delete({ id, ext });
				if (deleted.error && deleted.error.name !== 'NotFound')
					return Err(deleted.error.message);
			}
			return Ok(undefined);
		},
	};
}
