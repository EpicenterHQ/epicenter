/**
 * Recordings written into Whispering's files as they record (ADR-0543,
 * decision 84): on the desktop the shell's WAV from the first sample, kept in
 * the folder's `.epicenter/recording` until it stops and then moved to
 * `recordings/<id>.wav`; in a browser each piece appended to its file as it
 * arrives. The note is made when recording starts, so the files always name
 * what they hold, and completed with the length when it stops. A recording
 * a quit, a crash, or a closed tab cut off has a note without a length; the
 * capture device repairs its audio and, on the desktop, moves it to its path
 * (`CaptureDevice.recover`); the next start completes its note from the
 * audio's own bytes.
 */
import type { Client } from '@epicenter/definition/contract';
import { audioDurationMs } from '@epicenter/recorder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { CaptureSource } from './capture.js';
import type { Whispering } from './contract.js';

/** A recording's note as it is made at Start: no length yet. */
export type StartedRecording = {
	readonly id: string;
	readonly title: string;
	readonly recordedAt: string;
	readonly capture: CaptureSource;
};

/** Make the note of a recording that is starting. */
export async function beginRecording(
	device: Client<Whispering>,
	note: StartedRecording,
): Promise<Result<void, string>> {
	const created = await device.recordings.create(note);
	return created.error === null ? Ok(undefined) : Err(created.error.message);
}

/**
 * Write recording `id`'s length into its note, over the version read now
 * (the title may have been edited while it recorded). A note deleted in
 * the meantime is not made again: the audio stays in the folder.
 */
export async function completeRecording(
	device: Client<Whispering>,
	id: string,
	durationMs: number,
): Promise<Result<void, string>> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const read = await device.recordings.get({ id });
		if (read.error !== null)
			return Err(
				read.error.name === 'NotFound'
					? 'This recording’s note was deleted while it recorded. Its audio is still there.'
					: read.error.message,
			);
		if (read.data.durationMs === durationMs) return Ok(undefined);
		const updated = await device.recordings.update(
			{ id },
			{ durationMs: Math.max(0, Math.round(durationMs)) },
			{ over: read.data.version },
		);
		if (updated.error === null) return Ok(undefined);
		// Edited between the read and the write: read again.
		if (updated.error.name !== 'Conflict') return Err(updated.error.message);
	}
	return Err(
		'This recording’s note kept changing, so its length was not written.',
	);
}

/** The extensions recordings are written under: WAV on the desktop, AAC in MP4 or Opus in WebM in a browser. */
const RECORDED = ['wav', 'm4a', 'webm'] as const;

/**
 * Complete every recording whose note has no length once its audio
 * (`<id>.<ext>`) is there: what a quit, a crash, or a closed tab cut off.
 * `repair` (the capture device's `recover`) runs first, and only when some
 * note has no length: on the desktop it is what moves a cut-off recording
 * from `.epicenter/recording` to its path, so its audio is not there before
 * it runs; in a browser it reads every recording's audio, which no start
 * should pay for when nothing was cut off. Run it before anything records.
 * Answers the ids completed; a note with no audio, or whose audio does not
 * read, is left as it is.
 */
export async function finishCutOffRecordings(
	device: Client<Whispering>,
	repair: () => Promise<Result<unknown, { message: string }>>,
): Promise<Result<string[], string>> {
	const listed = await device.recordings.list();
	if (listed.error !== null) return Err(listed.error.message);
	const unfinished = listed.data.items
		.filter((note) => note.durationMs === undefined)
		.map((note) => note.id);
	if (unfinished.length === 0) return Ok([]);
	const repaired = await repair();
	if (repaired.error !== null) return Err(repaired.error.message);
	const finished: string[] = [];
	for (const id of unfinished)
		for (const ext of RECORDED) {
			const audio = await device.audio.get({ id, ext });
			if (audio.error !== null) continue;
			const durationMs = audioDurationMs(audio.data.bytes, ext);
			if (durationMs === undefined) break;
			const completed = await completeRecording(device, id, durationMs);
			if (completed.error === null) finished.push(id);
			break;
		}
	return Ok(finished);
}

/**
 * Remove the note of a recording that did not start (the microphone was
 * refused or not there), so the files name no recording they do not hold.
 * Audio already written is never removed here.
 */
export async function abandonRecording(
	device: Client<Whispering>,
	id: string,
): Promise<void> {
	const read = await device.recordings.get({ id });
	if (read.error !== null) return;
	const audio = await device.audio.list();
	if (audio.data?.items.some((file) => file.id === id)) return;
	await device.recordings.delete({ id }, { over: read.data.version });
}
