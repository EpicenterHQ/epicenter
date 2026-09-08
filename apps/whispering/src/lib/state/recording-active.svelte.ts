import { manualRecorder } from './manual-recorder.svelte';
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
export const recordingActive = {
	get current(): boolean {
		return (
			pendingWork > 0 ||
			manualRecorder.isStarting ||
			manualRecorder.state === 'RECORDING' ||
			vadRecorder.state !== 'IDLE'
		);
	},
};
