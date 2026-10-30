/**
 * The demo's save of a recording, kept out of the components so it can be
 * tested against a real device client.
 */
import type { Client } from '@epicenter/definition/contract';
import { outboxOf } from '@epicenter/folder/browser';
import { Ok } from 'wellcrafted/result';
import type { Recorder } from '../contract.ts';

/**
 * Keep a finished recording on the device as one capture: the audio first,
 * then its note, then the outbox entry that uploads both together once
 * someone is signed in (decision 12). A failure leaves what was written, and
 * running it again with the same recording picks that up and finishes: a
 * file already there under this recording's id is the one an earlier
 * attempt kept, and a capture already recorded is the one it added.
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
	const createdAudio = await device.audio.create({ id, ext, bytes });
	const audio =
		createdAudio.error?.name === 'Occupied'
			? await device.audio.get({ id, ext })
			: createdAudio;
	if (audio.error !== null) return audio;
	const createdNote = await device.recordings.create({
		id,
		title,
		recordedAt,
		durationMs,
	});
	const note =
		createdNote.error?.name === 'Occupied'
			? await device.recordings.get({ id })
			: createdNote;
	if (note.error !== null) return note;
	const outbox = outboxOf(device);
	const added = await outbox.add({
		id,
		files: [
			{ collection: 'audio', id, ext, version: audio.data.version },
			{ collection: 'recordings', id, version: note.data.version },
		],
	});
	if (added.error?.name !== 'Occupied') return added;
	// An earlier attempt recorded the capture and failed after.
	const listed = await outbox.list();
	if (listed.error !== null) return listed;
	const capture = listed.data.items.find((item) => item.id === id);
	return capture ? Ok(capture) : added;
}
