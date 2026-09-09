import type { WhisperingApp } from '../whispering/app.js';
import { vadRecorder } from './vad-recorder.svelte';

let pendingWork = $state(0);
const pending = new Set<Promise<unknown>>();

/** Keep account changes disabled through capture startup, finalization, and saving. */
export async function trackRecordingWork<T>(
	operation: () => Promise<T>,
): Promise<T> {
	pendingWork++;
	let work: Promise<T> | undefined;
	try {
		work = operation();
		pending.add(work);
		return await work;
	} finally {
		if (work) pending.delete(work);
		pendingWork--;
	}
}

/** Call after recording admission stops; wait for every already-admitted write. */
export async function drainRecordingWork(): Promise<void> {
	let failure: PromiseRejectedResult | undefined;
	while (pending.size) {
		const results = await Promise.allSettled([...pending]);
		failure ??= results.find((result) => result.status === 'rejected');
	}
	if (failure) throw failure.reason;
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
