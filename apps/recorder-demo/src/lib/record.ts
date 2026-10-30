/**
 * One recording from a `MediaStream`, in the format decision 56 picks.
 * `stop()` answers the bytes, the extension of the type the browser actually
 * produced, and how long it ran.
 */
import { chooseRecordingType, extensionOf } from './recording-format.ts';

export type Recorded = {
	bytes: Uint8Array;
	ext: string;
	durationMs: number;
};

export function startRecording(stream: MediaStream) {
	const mimeType = chooseRecordingType((type) =>
		MediaRecorder.isTypeSupported(type),
	);
	const recorder = new MediaRecorder(
		stream,
		mimeType ? { mimeType } : undefined,
	);
	const chunks: Blob[] = [];
	const startedAt = performance.now();
	recorder.addEventListener('dataavailable', (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	});
	const stopped = new Promise<Recorded>((resolve, reject) => {
		recorder.addEventListener('error', (event) =>
			reject((event as ErrorEvent).error ?? new Error('Recording failed')),
		);
		recorder.addEventListener('stop', async () => {
			for (const track of stream.getTracks()) track.stop();
			// The produced type, not the requested one: read it from the data.
			const type = chunks[0]?.type || recorder.mimeType;
			const ext = extensionOf(type);
			if (ext === null) {
				reject(new Error(`The browser recorded ${type || 'an unknown type'}`));
				return;
			}
			const blob = new Blob(chunks, { type });
			resolve({
				bytes: new Uint8Array(await blob.arrayBuffer()),
				ext,
				durationMs: Math.round(performance.now() - startedAt),
			});
		});
	});
	recorder.start(250);
	return {
		stop(): Promise<Recorded> {
			if (recorder.state !== 'inactive') recorder.stop();
			return stopped;
		},
	};
}
