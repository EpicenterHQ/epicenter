/**
 * The real microphone as a capture device: recording from one into
 * Whispering's files, over the inputs the same recorder lists, allows, and
 * tests.
 *
 * The platform leaf passes the `recorder` its build imports
 * (`@epicenter/recorder/browser` or `/tauri`) and nothing here chooses
 * between them: in a browser the page's own microphone, on the desktop the
 * shell's (ADR-0571), which lists inputs by name without access and asks
 * for access itself, so it has no `allow`. Either way the recording is
 * written into the store as it records, at `recordings/<id>.<ext>`.
 *
 * A chosen microphone is asked for by the exact ID the recorder listed it
 * under. When that one cannot be opened, the answer is a refusal: no other
 * microphone is opened in its place.
 */
import type { Client } from '@epicenter/definition/contract';
import type { Recorder } from '@epicenter/recorder';
import { Err, Ok } from 'wellcrafted/result';
import type { CaptureDevice } from './capture.js';
import type { Whispering } from './contract.js';

/** Where recordings are written. */
const DIRECTORY = 'recordings';

export function createMicrophoneDevice({
	device,
	recorder,
}: {
	/** Whispering's files, which every recording is written into. */
	device: Client<Whispering>;
	/** Lists, tests, and records from the microphone. */
	recorder: Recorder;
}): CaptureDevice {
	return {
		inputs: recorder,
		async start({ id, input, signal }) {
			const { data: recording, error } = await recorder.start({
				device,
				path: `${DIRECTORY}/${id}`,
				input,
				signal,
			});
			if (error !== null) return Err(error);
			const startedAt = performance.now();
			return Ok({
				startedAt,
				onEnded: recording.onEnded,
				async stop() {
					const { data, error: stopError } = await recording.stop();
					if (stopError !== null) return Err(stopError);
					return Ok({ durationMs: data.durationMs });
				},
			});
		},
		async recover(unnamed) {
			// In a browser a cut-off recording is at its path, among `unnamed`.
			if (unnamed.length === 0 && !recorder.placesWhole)
				return Ok({ whole: [], unplaced: [] });
			const { data, error } = await recorder.recover({
				device,
				under: DIRECTORY,
			});
			if (error !== null) return Err(error);
			const { unplaced } = data;
			const repaired = data.recovered.map(({ path, durationMs }) => ({
				id: path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
				durationMs,
			}));
			if (!recorder.placesWhole) return Ok({ whole: repaired, unplaced });
			// Audio at its path is finished: one placed after its page left,
			// or one whose note was never written.
			const answered = new Set(repaired.map(({ id }) => id));
			return Ok({
				whole: [
					...repaired,
					...unnamed
						.filter((id) => !answered.has(id))
						.map((id) => ({ id, durationMs: null })),
				],
				unplaced,
			});
		},
	};
}
