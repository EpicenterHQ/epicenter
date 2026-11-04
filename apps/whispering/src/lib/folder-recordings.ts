/**
 * A recording's note (ADR-0543, decision 84). Its audio is written into
 * Whispering's files as it records: on the desktop the shell's Opus in WebM
 * from the first sample, outside its path in the folder's
 * `.epicenter/recordings` until Stop finishes it and places it at
 * `recordings/<id>.webm`; in a browser each piece appended to its file at
 * its path as it arrives. The note is written once, when Stop has answered
 * and the audio is at its path (`keepRecording`), so a note always names
 * audio that is there and holds its length.
 *
 * A quit, a crash, or a closed tab leaves audio no note names: at its path
 * in a browser, outside it on the desktop. The next start repairs it
 * (`CaptureDevice.recover`, which on the desktop also finishes and places
 * it) and gives each such recording its note (`finishCutOffRecordings`), the
 * only path by which a cut-off recording reaches the library. On the
 * desktop nothing else can read a cut-off recording first: it is at no data
 * path until recovery has finished it. One whose path another file took
 * stays outside it, finished, and is said on every start until a person
 * moves one of the two; nothing deletes it.
 *
 * Both write through Whispering's folder (`folder` from `app.ts`), so the
 * library shows a note as soon as it lands and the folder's `saving()` (the
 * page's leave guard) counts it while it is out.
 */
import { timeOf } from '@epicenter/definition/ids';
import type { Folder, OpenFolderError } from '@epicenter/folder/core';
import { audioDurationMs, type UnplacedRecording } from '@epicenter/recorder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { CaptureDevice } from './capture.js';
import type { Whispering } from './contract.js';

/** Whispering's files as a folder, as much of it as a recording's note needs. */
type Files = Pick<Folder<Whispering>, 'recordings' | 'audio'>;

/** A recording's note, as it is written once its audio is at its path. */
export type KeptRecording = {
	readonly id: string;
	readonly title: string;
	readonly recordedAt: string;
	/** Undefined only for recovered audio whose length does not read. */
	readonly durationMs?: number;
};

/** Write the note of a recording whose audio is at its path. */
export async function keepRecording(
	files: Pick<Files, 'recordings'>,
	{ durationMs, ...note }: KeptRecording,
): Promise<Result<void, string>> {
	const created = await files.recordings.create(
		durationMs === undefined
			? note
			: { ...note, durationMs: Math.max(0, Math.round(durationMs)) },
	);
	return created.error === null ? Ok(undefined) : Err(created.error.message);
}

/** The extensions a recording's audio is kept under: Opus in WebM on the desktop, AAC in MP4 or Opus in WebM in a browser, and WAV. */
const RECORDED: readonly string[] = ['wav', 'm4a', 'webm'];

/**
 * Give every recording a quit, a crash, or a closed tab cut off its note.
 * The capture device's `recover` repairs what was cut off (on the desktop it
 * also finishes it and places it at its path) and answers each recording
 * whose audio is whole at its path, with the length it read; any of those no note
 * names is given one, its length measured from its audio when `recover` did
 * not answer one. Audio whose length does not read is still given a note,
 * without a length, so no recording is kept where the library does not
 * list it. Run it before anything records.
 *
 * Answers the ids given a note (`noted`), and each recording `recover` kept
 * outside its path because another file is there (`unplaced`), for the
 * caller to say. `Unavailable` is the files refusing to be listed at all,
 * which the library's own listing reports too. Over a folder of a client
 * already open, the open's own error (`OpenFolderError`) never answers.
 */
export async function finishCutOffRecordings(
	files: Files,
	capture: Pick<CaptureDevice, 'recover'>,
): Promise<
	Result<
		{ noted: string[]; unplaced: readonly UnplacedRecording[] },
		{ name: 'Unavailable' | 'RepairFailed'; message: string } | OpenFolderError
	>
> {
	const notes = await files.recordings.list();
	if (notes.error !== null) return Err(notes.error);
	const audio = await files.audio.list();
	if (audio.error !== null) return Err(audio.error);
	const named = new Set(
		[...notes.data.items, ...notes.data.invalid].map((note) => note.id),
	);
	const unnamed = audio.data.items
		.filter((file) => RECORDED.includes(file.ext) && !named.has(file.id))
		.map((file) => `recordings/${file.id}.${file.ext}`);
	const recovered = await capture.recover(unnamed);
	if (recovered.error !== null)
		return Err({ name: 'RepairFailed', message: recovered.error.message });
	const noted: string[] = [];
	for (const { id, durationMs } of recovered.data.whole) {
		if (named.has(id)) continue;
		named.add(id);
		const kept = await keepRecording(files, {
			id,
			title: 'Recovered recording',
			recordedAt: (timeOf(id) ?? new Date()).toISOString(),
			durationMs: durationMs ?? (await measured(files, id)),
		});
		if (kept.error === null) noted.push(id);
	}
	return Ok({ noted, unplaced: recovered.data.unplaced });
}

/** How long recording `id`'s audio plays, read from its bytes. */
async function measured(
	files: Pick<Files, 'audio'>,
	id: string,
): Promise<number | undefined> {
	for (const ext of RECORDED) {
		const audio = await files.audio.read({ id, ext });
		if (audio.error === null) return audioDurationMs(audio.data.bytes, ext);
	}
	return undefined;
}
