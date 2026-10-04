import { tauri } from '#platform/tauri';
import { log } from '$lib/report';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';

// The one best-effort side effect for recording: pause whatever the system is
// playing while recording, resume it after. Recording never waits on this and
// never fails because of it.
//
// `chain` is the entire state: a promise resolving to the opaque session tokens
// we currently have paused (`[]` when nothing is paused). Every pause/resume
// tacks itself onto the tail, so the backend calls run strictly one after
// another: a late resume can never race a fresh pause from a quick
// stop-then-restart. The resolved value answers the only question resume needs
// ("which sessions did I pause?") and doubles as the "currently paused" flag.
// Both helpers always resolve, so the chain never wedges.
//
// Tokens are opaque platform identities (macOS output-active bundle ids /
// Windows AUMID / Linux MPRIS bus name); the frontend only ever round-trips them
// back to the backend.

let chain: Promise<string[]> = Promise.resolve([]);

function shouldPausePlayback(app: WhisperingApp): boolean {
	return Boolean(tauri && app.settings.get('recording.pausePlayback'));
}

async function pausePlayingSessions(): Promise<string[]> {
	if (!tauri) return [];
	// `pause()` is infallible across IPC: Rust logs any platform failure and
	// reports "paused nothing". The try/catch only guards an unexpected invoke
	// rejection (e.g. the command going missing), never a playback error.
	try {
		return await tauri.media.pause();
	} catch (error) {
		log.warn(new Error(`Failed to pause playback: ${String(error)}`));
		return [];
	}
}

async function resumeSessions(sessions: string[]): Promise<void> {
	if (!tauri || sessions.length === 0) return;
	// `resume()` is infallible across IPC, mirroring `pause()`.
	try {
		await tauri.media.resume(sessions);
	} catch (error) {
		log.warn(new Error(`Failed to resume playback: ${String(error)}`));
	}
}

export const recordingMedia = {
	/** Pause active playback if enabled. Fire-and-forget: recording never waits. */
	pause(app: WhisperingApp): void {
		if (!shouldPausePlayback(app)) return;
		// Already paused? Keep that set; otherwise pause what's playing now.
		chain = chain.then(async (paused) =>
			paused.length > 0 ? paused : await pausePlayingSessions(),
		);
	},

	/**
	 * Resume whatever the matching `pause()` paused. A no-op when nothing was
	 * paused, so every stop/cancel/start-failure path can call it blindly.
	 */
	resume(): void {
		chain = chain.then(async (paused) => {
			await resumeSessions(paused);
			return [];
		});
	},
};
