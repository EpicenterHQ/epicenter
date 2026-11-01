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
 * path until recovery has finished it.
 */
import type { Client } from '@epicenter/definition/contract';
import { audioDurationMs } from '@epicenter/recorder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { CaptureDevice } from './capture.js';
import type { Whispering } from './contract.js';

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
	device: Client<Whispering>,
	{ durationMs, ...note }: KeptRecording,
): Promise<Result<void, string>> {
	const created = await device.recordings.create(
		durationMs === undefined
			? note
			: { ...note, durationMs: Math.max(0, Math.round(durationMs)) },
	);
	return created.error === null ? Ok(undefined) : Err(created.error.message);
}

/** The extensions a recording's audio is kept under: Opus in WebM on the desktop, AAC in MP4 or Opus in WebM in a browser, and WAV. */
const RECORDED: readonly string[] = ['wav', 'm4a', 'webm'];

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
 * Give every recording a quit, a crash, or a closed tab cut off its note.
 * The capture device's `recover` repairs what was cut off (on the desktop it
 * also finishes it and places it at its path) and answers each recording
 * whose audio is whole at its path, with the length it read; any of those no note
 * names is given one, its length measured from its audio when `recover` did
 * not answer one. Audio whose length does not read is still given a note,
 * without a length, so no recording is kept where the library does not
 * list it. Run it before anything records.
 *
 * Answers the ids given a note. `Unavailable` is the files refusing to be
 * listed at all, which the library's own listing reports too.
 */
export async function finishCutOffRecordings(
	device: Client<Whispering>,
	capture: Pick<CaptureDevice, 'recover'>,
): Promise<
	Result<string[], { name: 'Unavailable' | 'RepairFailed'; message: string }>
> {
	const notes = await device.recordings.list();
	if (notes.error !== null) return Err(notes.error);
	const audio = await device.audio.list();
	if (audio.error !== null) return Err(audio.error);
	const named = new Set(
		[...notes.data.items, ...notes.data.invalid].map((note) => note.id),
	);
	const unnamed = [
		...new Set(
			audio.data.items
				.filter((file) => RECORDED.includes(file.ext) && !named.has(file.id))
				.map((file) => file.id),
		),
	];
	const whole = await capture.recover(unnamed);
	if (whole.error !== null)
		return Err({ name: 'RepairFailed', message: whole.error.message });
	const made: string[] = [];
	for (const { id, durationMs } of whole.data) {
		if (named.has(id)) continue;
		named.add(id);
		const kept = await keepRecording(device, {
			id,
			title: 'Recovered recording',
			recordedAt: recordedAtOf(id),
			durationMs: durationMs ?? (await measured(device, id)),
		});
		if (kept.error === null) made.push(id);
	}
	return Ok(made);
}

/** How long recording `id`'s audio plays, read from its bytes. */
async function measured(
	device: Client<Whispering>,
	id: string,
): Promise<number | undefined> {
	for (const ext of RECORDED) {
		const audio = await device.audio.get({ id, ext });
		if (audio.error === null) return audioDurationMs(audio.data.bytes, ext);
	}
	return undefined;
}
