/**
 * The demo's save of a recording, kept out of the components so it can be
 * tested against a real device client.
 */
import type { Client } from '@epicenter/definition/contract';
import { outboxOf } from '@epicenter/folder/browser';
import type { Recorder } from '../contract.ts';

/**
 * Keep a finished recording on the device as one capture: the audio first,
 * then its note, then the outbox entry that uploads both together once
 * someone is signed in (decision 12). A failure leaves what was written; the
 * uploader adopts files no capture names.
 */
export async function saveRecording(
	device: Client<Recorder>,
	recording: {
		id: string;
		title: string;
		recordedAt: string;
		durationMs: number;
		ext: string;
		bytes: Uint8Array;
	},
) {
	const { id, title, recordedAt, durationMs, ext, bytes } = recording;
	const audio = await device.audio.create({ id, ext, bytes });
	if (audio.error !== null) return audio;
	const note = await device.recordings.create({
		id,
		title,
		recordedAt,
		durationMs,
	});
	if (note.error !== null) return note;
	return outboxOf(device).add({
		id,
		files: [
			{ collection: 'audio', ...audio.data },
			{ collection: 'recordings', ...note.data },
		],
	});
}
