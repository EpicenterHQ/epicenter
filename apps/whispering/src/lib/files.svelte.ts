/**
 * Whispering's files as one set of lists: what this browser holds (still to
 * upload) and, signed in, what the person's `whispering` repository holds
 * (decision 12).
 *
 * - Each note collection is one `oneList` (`@epicenter/svelte/client`): a
 *   note on the device shows as the device's ("not uploaded yet") until the
 *   upload lets go of it; writes go to the copy shown; a new note goes to the
 *   repository when it can be reached, else stays on the device and is queued
 *   to upload. So every view reads and edits without knowing which side it
 *   is on.
 * - A recording is always kept on the device first, its audio and note as
 *   one capture (`saveCapture`), so recording never waits on the network and
 *   works offline; the uploader moves both together.
 * - A recording's audio is read from wherever it is nearest: the device,
 *   then the device's cache of audio it uploaded (decision 66, read only,
 *   which the browser may drop), then the repository. So a recording made
 *   here keeps playing and transcribing after it uploads, offline included.
 *
 * Reads are Svelte state: each list lists and listens only while something
 * reactive reads it. Writes answer a `Result`; the caller presents failures.
 */
import type {
	Client,
	InvalidNoteOf,
	Version,
} from '@epicenter/definition/contract';
import { cacheOf, outboxOf, saveCapture } from '@epicenter/folder/browser';
import {
	fromClient,
	type ListedNote,
	type OneList,
	oneList,
	type Side,
} from '@epicenter/svelte/client';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from './audio-format.js';
import { type Whispering, whispering } from './contract.js';

type Collections = Whispering['collections'];

/** The note collections, by name. */
export type NoteName = Exclude<keyof Collections, 'audio'>;

/** A note of `name` as the lists show it: its fields, body, version, and side. */
export type Listed<TName extends NoteName> = ListedNote<Collections[TName]>;
export type RecordingNote = Listed<'recordings'>;
export type TranscriptionNote = Listed<'transcriptions'>;
export type TransformationNote = Listed<'transformations'>;
export type TransformationRunNote = Listed<'transformation_runs'>;
export type TextRunNote = Listed<'text_runs'>;

/** A note at one of `name`'s paths that does not read, with its text and side. */
export type InvalidNote<TName extends NoteName> = InvalidNoteOf<
	Collections[TName]
> & { where: Side };

/** One audio file a recording has, and where the copy that would be read is. */
export type AudioFile = {
	readonly id: string;
	readonly ext: string;
	/** The repository's version of it; null while it is only on this device. */
	readonly version: Version | null;
	/**
	 * Still on this device (not uploaded yet), in the repository, or only in
	 * this device's cache while the repository cannot be listed.
	 */
	readonly where: Side | 'cache';
	/** Whether this device's cache holds its bytes, so it reads without the network. */
	readonly cached: boolean;
};

/** Whether a recording's audio can be read, and from where. */
export type RecordingAudio =
	/** Nothing has been listed yet. */
	| { readonly kind: 'listing' }
	| { readonly kind: 'here'; readonly file: AudioFile }
	/** No side holds audio for it. */
	| { readonly kind: 'absent' }
	/** It may be in the repository, which cannot be listed now, and nothing is cached. */
	| { readonly kind: 'unreachable' }
	/** More than one audio file shares the recording's id. */
	| { readonly kind: 'ambiguous'; readonly exts: readonly string[] };

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

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Newest first by `at`, then by id (ids sort by when they were made). */
const newest =
	<T extends { id: string }>(at: (item: T) => string) =>
	(a: T, b: T) =>
		byText(at(b), at(a)) || byText(b.id, a.id);

/**
 * Whispering's files over this browser's `device` and, signed in,
 * `repository` (null signed out). What the device makes is queued in its
 * outbox, to upload once someone is signed in.
 */
export function createWhisperingFiles({
	device,
	repository,
}: {
	device: Client<Whispering>;
	repository: Client<Whispering> | null;
}) {
	const here = fromClient(device);
	const there = repository === null ? null : fromClient(repository);
	const outbox = outboxOf(device);
	const cache = cacheOf(device);

	const list = <TName extends NoteName>(
		name: TName,
		order: (a: Listed<TName>, b: Listed<TName>) => number,
	): OneList<Collections[TName]> =>
		oneList(whispering, name, {
			// SAFETY: a note collection's reactive collection is its notes'; the
			// generic name does not narrow `ReactiveCollection`'s conditional.
			device: here[name] as never,
			repository: (there?.[name] ?? null) as never,
			outbox,
			order: order as never,
		});

	const lists = {
		recordings: list(
			'recordings',
			newest((note) => note.recordedAt),
		),
		transcriptions: list(
			'transcriptions',
			newest((note) => note.createdAt),
		),
		transformations: list(
			'transformations',
			(a, b) =>
				(a.title || a.id).localeCompare(b.title || b.id, undefined, {
					sensitivity: 'base',
				}) || byText(a.id, b.id),
		),
		transformation_runs: list(
			'transformation_runs',
			newest((note) => note.createdAt),
		),
		text_runs: list(
			'text_runs',
			newest((note) => note.createdAt),
		),
	};

	/**
	 * The audio this device's uploads cached, by `<id>.<ext>`. The cache is
	 * outside the contract, so it is read again whenever either side's audio
	 * changes: an upload caches its audio, then lets go of the device's copy.
	 * Signed out there is none (an account's cache goes with it).
	 */
	let cached = $state.raw<ReadonlySet<string>>(new Set());
	const stopCache = $effect.root(() => {
		$effect(() => {
			if (there === null) return;
			void [here.audio.items, there.audio.items];
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

	/** Every recording's audio files, by recording id: the device's copy over the repository's. */
	const audioById = $derived.by(() => {
		const byKey = new Map<string, AudioFile>();
		const add = (file: AudioFile) => byKey.set(`${file.id}.${file.ext}`, file);
		for (const { id, ext, version } of there?.audio.items ?? [])
			add({
				id,
				ext,
				version,
				where: 'repository',
				cached: cached.has(`${id}.${ext}`),
			});
		// Offline, what the device cached still reads, though no listing names it.
		if (there?.audio.error)
			for (const key of cached)
				if (!byKey.has(key)) {
					const dot = key.lastIndexOf('.');
					add({
						id: key.slice(0, dot),
						ext: key.slice(dot + 1),
						version: null,
						where: 'cache',
						cached: true,
					});
				}
		for (const { id, ext } of here.audio.items)
			add({ id, ext, version: null, where: 'device', cached: false });
		const byId = new Map<string, AudioFile[]>();
		for (const file of byKey.values())
			byId.set(file.id, [...(byId.get(file.id) ?? []), file]);
		return byId;
	});

	function audioOf(id: string): RecordingAudio {
		const files = (audioById.get(id) ?? []).filter(
			(file) => audioMimeTypeOf(`x.${file.ext}`) !== undefined,
		);
		const [file, ...more] = files;
		if (file !== undefined && more.length === 0) return { kind: 'here', file };
		if (file !== undefined)
			return { kind: 'ambiguous', exts: files.map(({ ext }) => ext).sort() };
		if (here.audio.loading || (there?.audio.loading ?? false))
			return { kind: 'listing' };
		return there?.audio.error ? { kind: 'unreachable' } : { kind: 'absent' };
	}

	return {
		...lists,
		/** Whether a repository is open beside the device: someone is signed in. */
		signedIn: there !== null,
		/** Why the repository could not be listed (offline, or refused); null when it can be, or signed out. */
		get repositoryError() {
			return there?.recordings.error ?? there?.audio.error ?? null;
		},
		/** Why this device's files could not be listed (no private storage, as in a private window). */
		get deviceError() {
			return here.recordings.error ?? here.audio.error ?? null;
		},

		/** Where recording `id`'s audio is, read reactively. */
		audioOf,

		/**
		 * Recording `id`'s audio bytes, from the nearest copy: this device, its
		 * cache, then the repository (a download).
		 */
		async readAudio(id: string): Promise<Result<AudioBytes, string>> {
			const audio = audioOf(id);
			if (audio.kind === 'ambiguous')
				return Err(
					`More than one audio file has this recording’s id (${audio.exts.join(', ')}). Keep one.`,
				);
			if (audio.kind === 'listing')
				return Err('This recording’s audio has not been listed yet.');
			if (audio.kind === 'unreachable')
				return Err(
					'This recording’s audio is in your repository, which cannot be reached now.',
				);
			if (audio.kind === 'absent')
				return Err('This recording has no audio file.');
			const { file } = audio;
			const found = (bytes: Uint8Array) =>
				Ok({
					bytes,
					ext: file.ext,
					name: `${file.id}.${file.ext}`,
					mimeType:
						audioMimeTypeOf(`x.${file.ext}`) ?? 'application/octet-stream',
				});
			if (file.where === 'device') {
				const read = await device.audio.get({ id, ext: file.ext });
				return read.error === null
					? found(read.data.bytes)
					: Err(read.error.message);
			}
			if (file.cached) {
				// Online, only the repository's version answers; offline, the cache is all there is.
				const read = await cache.read(
					{ collection: 'audio', id, ext: file.ext },
					file.version === null ? {} : { version: file.version },
				);
				if (read.data) return found(read.data.bytes);
			}
			if (repository === null || file.where === 'cache')
				return Err(
					'This recording’s audio is in your repository, which cannot be reached now.',
				);
			const read = await repository.audio.get({ id, ext: file.ext });
			return read.error === null
				? found(read.data.bytes)
				: Err(read.error.message);
		},

		/**
		 * Delete recording `id`'s audio from each side that lists it: both,
		 * while an upload of it is under way. A copy in the repository is
		 * deleted only online.
		 */
		async deleteAudio(id: string): Promise<Result<void, string>> {
			const sides = [here, ...(there === null ? [] : [there])];
			for (const side of sides)
				for (const { ext } of side.audio.items.filter(
					(file) => file.id === id,
				)) {
					const deleted = await side.audio.delete({ id, ext });
					if (deleted.error && deleted.error.name !== 'NotFound')
						return Err(deleted.error.message);
				}
			return Ok(undefined);
		},

		/**
		 * Keep a finished recording on this device: its audio, then its note,
		 * as one capture that uploads once someone is signed in. Run again with
		 * the same recording after a failure, it finishes what was kept.
		 */
		async saveRecording(
			recording: NewRecording,
		): Promise<Result<void, string>> {
			const { id, ext, bytes, ...note } = recording;
			const saved = await saveCapture(device, {
				id,
				files: [
					{ collection: 'audio', value: { id, ext, bytes } },
					{ collection: 'recordings', value: { id, ...note } },
				],
			});
			return saved.error === null ? Ok(undefined) : Err(saved.error.message);
		},

		/** Stop following the cache. */
		dispose: stopCache,
	};
}

export type WhisperingFiles = ReturnType<typeof createWhisperingFiles>;
