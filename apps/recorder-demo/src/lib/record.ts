/**
 * How each variant records, both through `@epicenter/recorder/browser`
 * (decision 84):
 *
 * - The local variant writes into this browser's files as it records
 *   (`recordInto`): each piece of audio is appended to
 *   `recordings/{id}.{ext}` as it arrives, so a closed tab keeps it, and
 *   only the note waits for Stop (the contract requires its length).
 * - The online variant's store is the repository, written when a recording
 *   stops, so it holds the audio in the page until then (`recordInPage`).
 */
import type { Client } from '@epicenter/definition/contract';
import {
	type RecorderError,
	recorder,
	startPageRecording,
} from '@epicenter/recorder/browser';
import { Ok, type Result } from 'wellcrafted/result';
import type { Recorder } from '../contract.ts';

/** A stopped recording: its audio already in the store, or its bytes, still in the page. */
export type Stopped = { ext: string; durationMs: number } & (
	| { written: true }
	| { written: false; bytes: Uint8Array }
);

/** A recording under way. */
export type Take = {
	stop(): Promise<Result<Stopped, RecorderError>>;
};

/** Start recording `id`. */
export type Record = (id: string) => Promise<Result<Take, RecorderError>>;

/** Record into `device`, this browser's files, as it records. */
export function recordInto(device: Client<Recorder>): Record {
	return async (id) => {
		const started = await recorder.start({
			device,
			path: `recordings/${id}`,
		});
		if (started.error !== null) return started;
		const recording = started.data;
		return Ok({
			async stop() {
				const stopped = await recording.stop();
				if (stopped.error !== null) return stopped;
				// A browser wrote it at its path as it recorded.
				const { path, durationMs } = stopped.data;
				return Ok({
					written: true,
					ext: path.slice(path.lastIndexOf('.') + 1),
					durationMs,
				});
			},
		});
	};
}

/** Record in the page; Stop answers the audio for the store to take. */
export const recordInPage: Record = async () => {
	const started = await startPageRecording();
	if (started.error !== null) return started;
	const recording = started.data;
	return Ok({
		async stop() {
			const stopped = await recording.stop();
			if (stopped.error !== null) return stopped;
			const { bytes, extension, durationMs } = stopped.data;
			return Ok({ written: false, bytes, ext: extension, durationMs });
		},
	});
};
