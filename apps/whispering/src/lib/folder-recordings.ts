/**
 * Recordings written into Whispering's files as they record (ADR-0543,
 * decision 84): on the desktop the shell's WAV from the first sample, kept
 * beside its path as the hidden `recordings/.<id>.wav.epicenter-pending`
 * until it stops and then moved to `recordings/<id>.wav`; in a browser each piece appended to its file as it
 * arrives. The note is made when recording starts, so the files always name
 * what they hold, and completed with the length when it stops. A recording
 * a quit, a crash, or a closed tab cut off has a note without a length; the
 * capture device repairs its audio and, on the desktop, moves it to its path
 * (`CaptureDevice.recover`); the next start completes its note from the
 * audio's own bytes. A Stop that fails keeps the note unless nothing was
 * written, so audio the desktop could not move into place is named when the
 * next start moves it.
 */
import type { Client } from '@epicenter/definition/contract';
import { audioDurationMs } from '@epicenter/recorder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { CaptureDevice, CaptureSource } from './capture.js';
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

/** When a recording whose id `timeId` made was started, or now for any other id. */
function recordedAtOf(id: string): string {
	const stamp = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(
		id,
	);
	const at = stamp
		? new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`)
		: new Date(Number.NaN);
	return (Number.isNaN(at.getTime()) ? new Date() : at).toISOString();
}

/**
 * Complete every recording whose note has no length once its audio
 * (`<id>.<ext>`) is there: what a quit, a crash, or a closed tab cut off.
 * The capture device's `recover` runs first, and only when some note has
 * no length: on the desktop it is what moves a cut-off recording from its
 * hidden unfinished name to its path (or beside it, `<id>-recovered`, when
 * the path is taken), so its audio is not there before it runs; in a
 * browser it reads every recording's audio, which no start should pay for
 * when nothing was cut off. Run it before anything records.
 *
 * Audio `recover` placed that no note names is given one, so no recording
 * is kept where the library does not list it. A note whose recording the
 * device calls silent (`silent`: a tab closed before its first piece) is
 * settled with a length of 0 once, so it does not send the next start
 * through recovery again. Any other note with no audio, or whose audio does
 * not read, is left as it is.
 *
 * Answers the ids completed. `Unavailable` is the files refusing to be
 * listed at all, which the library's own listing reports too.
 */
export async function finishCutOffRecordings(
	device: Client<Whispering>,
	capture: Pick<CaptureDevice, 'recover' | 'silent'>,
): Promise<
	Result<string[], { name: 'Unavailable' | 'RepairFailed'; message: string }>
> {
	const listed = await device.recordings.list();
	if (listed.error !== null) return Err(listed.error);
	const unfinished = listed.data.items
		.filter((note) => note.durationMs === undefined)
		.map((note) => note.id);
	if (unfinished.length === 0) return Ok([]);
	const repaired = await capture.recover();
	if (repaired.error !== null)
		return Err({ name: 'RepairFailed', message: repaired.error.message });
	const named = new Set([
		...listed.data.items.map((note) => note.id),
		...listed.data.invalid.map((note) => note.id),
	]);
	for (const id of repaired.data) {
		if (named.has(id)) continue;
		const made = await beginRecording(device, {
			id,
			title: 'Recovered recording',
			recordedAt: recordedAtOf(id),
			capture: 'microphone',
		});
		if (made.error === null) unfinished.push(id);
	}
	const finished: string[] = [];
	const silent: string[] = [];
	for (const id of unfinished) {
		let heard = false;
		for (const ext of RECORDED) {
			const audio = await device.audio.get({ id, ext });
			if (audio.error !== null) continue;
			heard = true;
			const durationMs = audioDurationMs(audio.data.bytes, ext);
			if (durationMs === undefined) break;
			const completed = await completeRecording(device, id, durationMs);
			if (completed.error === null) finished.push(id);
			break;
		}
		if (!heard) silent.push(id);
	}
	if (silent.length > 0 && capture.silent !== undefined) {
		const settled = await capture.silent(silent);
		for (const id of settled.data ?? []) {
			const completed = await completeRecording(device, id, 0);
			if (completed.error === null) finished.push(id);
		}
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
