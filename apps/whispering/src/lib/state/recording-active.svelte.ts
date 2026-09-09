import type { WhisperingApp } from '../whispering/app.js';
import { vadRecorder } from './vad-recorder.svelte';

let pendingWork = $state(0);

/** Keep account changes disabled through capture startup, finalization, and saving. */
export async function trackRecordingWork<T>(
	operation: () => Promise<T>,
): Promise<T> {
	pendingWork++;
	try {
		return await operation();
	} finally {
		pendingWork--;
	}
}

/** Capture or admitted recording work still owns this App. */
export function recordingActive(
	app: Pick<WhisperingApp, 'recording'>,
): boolean {
	return (
		pendingWork > 0 ||
		app.recording.isStarting ||
		app.recording.state === 'RECORDING' ||
		vadRecorder.state !== 'IDLE'
	);
}
