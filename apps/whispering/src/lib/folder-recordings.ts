/**
 * Recordings the desktop shell writes into the data folder from their
 * first sample (ADR-0543): the note is made when recording starts, so the
 * folder always names what it holds, and completed with the length when it
 * stops. A recording a quit or a crash cut off has a note without a length
 * beside audio the shell repairs (`FolderCaptureDevice.recover`); the next
 * launch completes its note from the audio's own header.
 *
 * A browser keeps a recording only when it stops, as its audio and then its
 * note, so nothing here applies to it.
 */
import type { Client } from '@epicenter/definition/contract';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { wavDurationMs } from './audio-format.js';
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
					? 'This recording’s note was deleted while it recorded. Its audio is still in the folder.'
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

/**
 * Complete every recording whose note has no length while its audio
 * (`<id>.<ext>`) is there: what a quit or a crash cut off. Run it after the
 * shell repaired the audio's headers, before anything records. Answers the
 * ids completed; a note with no audio is left as it is.
 */
export async function finishCutOffRecordings(
	device: Client<Whispering>,
	ext: string,
): Promise<Result<string[], string>> {
	const listed = await device.recordings.list();
	if (listed.error !== null) return Err(listed.error.message);
	const finished: string[] = [];
	for (const note of listed.data.items) {
		if (note.durationMs !== undefined) continue;
		const audio = await device.audio.get({ id: note.id, ext });
		if (audio.error !== null) continue;
		const durationMs = wavDurationMs(audio.data.bytes);
		if (durationMs === undefined) continue;
		const completed = await completeRecording(device, note.id, durationMs);
		if (completed.error === null) finished.push(note.id);
	}
	return Ok(finished);
}

/**
 * Remove the note of a recording that did not start (the microphone was
 * refused or not there), so the folder names no recording it does not hold.
 * Audio the shell already wrote is never removed here.
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
