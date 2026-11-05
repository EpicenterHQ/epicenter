/**
 * The real microphone as a capture device: recording from one into
 * Whispering's files, over the inputs the same recorder lists, allows, and
 * tests.
 *
 * `src/lib/app.ts` makes it once, beside the folder, with the `recorder`
 * its build imports (`#platform/computer`: `@epicenter/recorder/browser` or
 * `/tauri`), and nothing here chooses between them: in a browser the page's
 * own microphone, on the desktop the shell's (ADR-0571), which lists inputs
 * by name without access and asks for access itself, so it has no `allow`.
 * Either way the recording is written into the folder as it records, at
 * `recordings/<id>.<ext>`.
 *
 * A chosen microphone is asked for by the exact ID the recorder listed it
 * under. When that one cannot be opened, the answer is a refusal: no other
 * microphone is opened in its place.
 */
import type { AudioFiles, Recorder } from '@epicenter/recorder';
import { Err, Ok } from 'wellcrafted/result';
import type { CaptureDevice } from './capture.js';

/** Where recordings are written. */
const DIRECTORY = 'recordings';

export function createMicrophoneDevice({
	files,
	recorder,
}: {
	/** Whispering's audio files (`folder.audio`), which every recording is written into. */
	files: AudioFiles;
	/** Lists, tests, and records from the microphone. */
	recorder: Recorder;
}): CaptureDevice {
	return {
		inputs: recorder,
		async start({ id, input, signal }) {
			const { data: recording, error } = await recorder.start({
				files,
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
			// Which of these is whole, and where else a cut-off one waits, is
			// the recorder's to know.
			const { data, error } = await recorder.recover({
				files,
				under: DIRECTORY,
				unnamed,
			});
			if (error !== null) return Err(error);
			return Ok({
				whole: data.recovered.map(({ path, durationMs }) => ({
					id: path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
					durationMs,
				})),
				unplaced: data.unplaced,
			});
		},
	};
}
