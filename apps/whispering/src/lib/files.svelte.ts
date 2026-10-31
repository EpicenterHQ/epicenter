/**
 * One view's files: the note lists of one client and a recording's audio
 * beside them (decision 76). Whispering has two views, each over its own
 * client, never merged:
 *
 * - "On this device" (`deviceFiles`): this browser's files (OPFS), signed
 *   in or not, online or not. A recording is kept here first; signed in,
 *   the uploader moves each file to the repository, and it leaves this view.
 * - "Synced" (`syncedFiles`): the person's `whispering` repository, signed
 *   in. A recording's audio is read from this browser's cache of what it
 *   uploaded (decision 66, read only, which the browser may drop), then the
 *   repository, so a recording made here keeps playing and transcribing
 *   after it uploads, offline included.
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
import { cacheOf } from '@epicenter/folder/browser';
import {
	fromClient,
	type ReactiveFiles,
	type ReactiveNotes,
} from '@epicenter/svelte/client';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';
import type { Whispering } from './contract.js';

type Collections = Whispering['collections'];

/** Which of Whispering's two views: this device's files, or the repository's. */
export type View = 'device' | 'synced';

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

/** One audio file a recording has in this view. */
export type AudioFile = {
	readonly id: string;
	readonly ext: string;
	/** Its version as listed; null when only this browser's cache holds it. */
	readonly version: Version | null;
	/** Whether this browser's cache holds its bytes, so it reads without the network. */
	readonly cached: boolean;
};

/** Whether a recording's audio can be read, and from where. */
export type RecordingAudio =
	/** Nothing has been listed yet. */
	| { readonly kind: 'listing' }
	| { readonly kind: 'here'; readonly file: AudioFile }
	/** This view holds no audio for it. */
	| { readonly kind: 'absent' }
	/** It may be in the repository, which cannot be listed now, and nothing is cached. */
	| { readonly kind: 'unreachable' }
	/** More than one audio file shares the recording's id. */
	| { readonly kind: 'ambiguous'; readonly exts: readonly string[] };

/** The folder path of a recording's one audio file, when it has one here. */
export const audioPathOf = (audio: RecordingAudio): string | undefined =>
	audio.kind === 'here'
		? `recordings/${audio.file.id}.${audio.file.ext}`
		: undefined;

/** A recording's audio, read. */
export type AudioBytes = {
	readonly bytes: Uint8Array;
	readonly ext: string;
	/** The file's name, `<id>.<ext>`, as an upload names it. */
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

/** Each note collection of one client, as the views read it. */
export type NoteLists = {
	readonly [K in NoteName]: ReactiveNotes<Collections[K]>;
};

/** One view's files: its note lists, and its recordings' audio. */
export type WhisperingFiles = NoteLists & {
	/** Which view these are. */
	readonly view: View;
	/** Where recording `id`'s audio is, read reactively. */
	audioOf(id: string): RecordingAudio;
	/** Recording `id`'s audio bytes. */
	readAudio(id: string): Promise<Result<AudioBytes, string>>;
	/** Delete recording `id`'s audio files from this view's client. */
	deleteAudio(id: string): Promise<Result<void, string>>;
	/** Stop following what these files follow beyond their lists. */
	dispose(): void;
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

const UNREACHABLE =
	'This recording’s audio is in your repository, which cannot be reached now.';

/** One client's note lists. */
function notesOf(client: Client<Whispering>): NoteLists {
	const files = fromClient(client);
	return {
		recordings: files.recordings,
		transcriptions: files.transcriptions,
		transformations: files.transformations,
		transformation_runs: files.transformation_runs,
		text_runs: files.text_runs,
	};
}

/** A recording's audio from the files a view lists for it. */
function audioIn(
	files: readonly AudioFile[],
	state: { loading: boolean; unreachable: boolean },
): RecordingAudio {
	const playable = files.filter(
		(file) => audioMimeTypeOf(`x.${file.ext}`) !== undefined,
	);
	const [file, ...more] = playable;
	if (file !== undefined && more.length === 0) return { kind: 'here', file };
	if (file !== undefined)
		return { kind: 'ambiguous', exts: playable.map(({ ext }) => ext).sort() };
	if (state.loading) return { kind: 'listing' };
	return state.unreachable ? { kind: 'unreachable' } : { kind: 'absent' };
}

/** Why `audio` cannot be read, or the one file to read. */
function readable(audio: RecordingAudio): Result<AudioFile, string> {
	if (audio.kind === 'here') return Ok(audio.file);
	if (audio.kind === 'ambiguous')
		return Err(
			`More than one audio file has this recording’s id (${audio.exts.join(', ')}). Keep one.`,
		);
	if (audio.kind === 'listing')
		return Err('This recording’s audio has not been listed yet.');
	if (audio.kind === 'unreachable') return Err(UNREACHABLE);
	return Err('This recording has no audio file.');
}

const bytesOf = (file: AudioFile, bytes: Uint8Array): AudioBytes => ({
	bytes,
	ext: file.ext,
	name: `${file.id}.${file.ext}`,
	mimeType: audioMimeTypeOf(`x.${file.ext}`) ?? 'application/octet-stream',
});

/** Delete each of recording `id`'s audio files `audio` lists, over the version listed. */
async function deleteListed(
	audio: ReactiveFiles<Collections['audio']>,
	id: string,
): Promise<Result<void, string>> {
	for (const { ext } of audio.items.filter((file) => file.id === id)) {
		const deleted = await audio.delete({ id, ext });
		if (deleted.error && deleted.error.name !== 'NotFound')
			return Err(deleted.error.message);
	}
	return Ok(undefined);
}

/** "On this device": this browser's files, and the audio beside them. */
export function deviceFiles(device: Client<Whispering>): WhisperingFiles {
	const audio = fromClient(device).audio;
	function audioOf(id: string) {
		return audioIn(
			audio.items
				.filter((file) => file.id === id)
				.map(({ ext, version }) => ({ id, ext, version, cached: false })),
			{ loading: audio.loading, unreachable: false },
		);
	}
	return {
		...notesOf(device),
		view: 'device',
		audioOf,
		async readAudio(id) {
			const { data: file, error } = readable(audioOf(id));
			if (error !== null) return Err(error);
			const read = await device.audio.get({ id, ext: file.ext });
			return read.error === null
				? Ok(bytesOf(file, read.data.bytes))
				: Err(read.error.message);
		},
		deleteAudio: (id) => deleteListed(audio, id),
		dispose() {},
	};
}

/**
 * "Synced": the repository's files, and the audio beside them, read from
 * this browser's cache of what it uploaded (`device`'s) before the
 * repository.
 */
export function syncedFiles(
	repository: Client<Whispering>,
	device: Client<Whispering>,
): WhisperingFiles {
	const audio = fromClient(repository).audio;
	const uploading = fromClient(device).audio;
	const cache = cacheOf(device);

	/**
	 * The audio this browser's uploads cached, by `<id>.<ext>`. The cache is
	 * outside the contract, so it is read again whenever the repository's
	 * audio or this device's changes: an upload caches its audio, then lets
	 * go of the device's copy.
	 */
	let cached = $state.raw<ReadonlySet<string>>(new Set());
	const stopCache = $effect.root(() => {
		$effect(() => {
			void [audio.items, uploading.items];
			let current = true;
			void cache.list().then(({ data }) => {
				if (!current || data === null) return;
				cached = new Set(
					data.items.flatMap((file) =>
						file.collection === 'audio' ? [`${file.id}.${file.ext}`] : [],
					),
				);
			});
			return () => {
				current = false;
			};
		});
	});

	/** Every recording's audio files, by recording id. */
	const audioById = $derived.by(() => {
		const byKey = new Map<string, AudioFile>();
		for (const { id, ext, version } of audio.items)
			byKey.set(`${id}.${ext}`, {
				id,
				ext,
				version,
				cached: cached.has(`${id}.${ext}`),
			});
		// Offline, what this browser cached still reads, though no listing names it.
		if (audio.error)
			for (const key of cached)
				if (!byKey.has(key)) {
					const dot = key.lastIndexOf('.');
					byKey.set(key, {
						id: key.slice(0, dot),
						ext: key.slice(dot + 1),
						version: null,
						cached: true,
					});
				}
		const byId = new Map<string, AudioFile[]>();
		for (const file of byKey.values())
			byId.set(file.id, [...(byId.get(file.id) ?? []), file]);
		return byId;
	});

	function audioOf(id: string) {
		return audioIn(audioById.get(id) ?? [], {
			loading: audio.loading,
			unreachable: audio.error !== null,
		});
	}

	return {
		...notesOf(repository),
		view: 'synced',
		audioOf,
		/**
		 * From this browser's cache when it holds the bytes (checked against
		 * the repository's version when listed), else the repository (a
		 * download). A download is not cached.
		 */
		async readAudio(id) {
			const { data: file, error } = readable(audioOf(id));
			if (error !== null) return Err(error);
			if (file.cached) {
				const read = await cache.read(
					{ collection: 'audio', id, ext: file.ext },
					file.version === null ? {} : { version: file.version },
				);
				if (read.data) return Ok(bytesOf(file, read.data.bytes));
			}
			if (file.version === null) return Err(UNREACHABLE);
			const read = await repository.audio.get({ id, ext: file.ext });
			return read.error === null
				? Ok(bytesOf(file, read.data.bytes))
				: Err(read.error.message);
		},
		/** Online only: the repository's copy is deleted there. */
		deleteAudio: (id) => deleteListed(audio, id),
		dispose: stopCache,
	};
}
