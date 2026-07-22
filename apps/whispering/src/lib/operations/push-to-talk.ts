import { log, report } from '$lib/report';
import type { RecordingSessionId } from '$lib/services/recorder/contract';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import type { WhisperingApp } from '$lib/whispering/app';
import { startManualRecording, stopManualRecordingSession } from './recording';

/**
 * Push-to-talk owns the capture session it starts. A press starts a session; a
 * release (the plugin's `Released` edge) or the 5-minute cap stops only that
 * session by its ephemeral id.
 *
 * Two correctness properties, both of which the bare "Released calls stop" model
 * lacked, and whose absence let a lost release edge leave recording stuck on:
 *
 * - Id-scoped: a press remembers the id of the session it started, so a stray
 *   or duplicated release (or one that lands after that session was supplanted
 *   by a toggle/button capture) never stops the wrong one.
 * - Startup-safe: a release that lands while the recording is still starting is
 *   latched (`stopRequested`) and honored the moment the recording exists, where
 *   checking the recorder state alone would miss it (it is not `RECORDING` yet).
 *
 * Push-to-talk is a physical hold, so presses are sequential; the generation id
 * still scopes every async continuation to its press, so a stale start completion
 * cannot arm a cap for a session already released.
 */

// Push-to-talk is for held dictation; long-form has the toggle command. The cap is
// the safety fuse for the one stuck-on path no edge covers (an OS-eaten key-up
// from sleep or a lock screen), not the primary stop, so a fixed generous value is
// enough. Not configurable until real usage asks for it.
const MAX_HOLD_MS = 5 * 60 * 1000;

type Session = {
	/** Scopes every async continuation to the press that began it. */
	id: number;
	/** The ready app whose command started this session. */
	app: WhisperingApp;
	/** The capture this press started, or null until startup resolves. */
	recordingSessionId: RecordingSessionId | null;
	/** A release that arrived before startup finished, honored once it exists. */
	stopRequested: boolean;
};

function createPushToTalk() {
	let generation = 0;
	let session: Session | null = null;
	let capTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingStart: Promise<void> | undefined;

	function clearSession() {
		session = null;
		clearTimeout(capTimer);
		capTimer = undefined;
	}

	/**
	 * The recording this session started ended by other means (cancel, toggle, a
	 * surface switch) without a release reaching us, so the session is stale: we
	 * hold a session but the recorder is neither recording nor starting.
	 */
	function sessionIsStale(): boolean {
		return (
			session !== null &&
			pendingStart === undefined &&
			manualRecorder.state !== 'RECORDING' &&
			!manualRecorder.isStarting
		);
	}

	async function end(
		app: WhisperingApp,
		id: number,
		options?: { capped?: boolean },
	) {
		if (session?.id !== id) return; // superseded by a newer press
		const { recordingSessionId } = session;
		clearSession();
		if (recordingSessionId) {
			await stopManualRecordingSession(app, recordingSessionId);
		}
		if (options?.capped) {
			report.info({
				title: 'Recording stopped',
				description: 'Push-to-talk hit the 5-minute limit.',
			});
		}
	}

	async function start(app: WhisperingApp) {
		// Drop a stale session whose recording already ended without a release, so a
		// fresh press is never blocked by it.
		if (sessionIsStale()) clearSession();
		if (session) return; // genuinely still holding (recording or starting)

		const id = ++generation;
		session = { id, app, recordingSessionId: null, stopRequested: false };
		const completion = Promise.withResolvers<void>();
		pendingStart = completion.promise;

		try {
			// Null means this press started nothing it owns: startup failed, or a
			// recording was already live (a toggle/button capture) so the start no-op'd.
			// Either way, do not arm a cap or stop another source's recording.
			let recordingSessionId: RecordingSessionId | null;
			try {
				recordingSessionId = await startManualRecording(app);
			} catch (cause) {
				if (session?.id === id) clearSession();
				throw cause;
			}

			if (session?.id !== id) {
				if (recordingSessionId) {
					await stopManualRecordingSession(app, recordingSessionId);
				}
				return;
			}
			if (!recordingSessionId) {
				clearSession();
				return;
			}
			session.recordingSessionId = recordingSessionId;
			// A release or app teardown arrived during startup: honor it now
			// that the recording exists, before the old app can be disposed.
			if (session.stopRequested) {
				await end(app, id);
				return;
			}
			capTimer = setTimeout(() => {
				void end(app, id, { capped: true }).catch((cause) =>
					log.warn(
						cause instanceof Error ? cause : new Error(String(cause)),
						'Push-to-talk cap failed to stop recording',
					),
				);
			}, MAX_HOLD_MS);
		} finally {
			completion.resolve();
			if (pendingStart === completion.promise) pendingStart = undefined;
		}
	}

	/**
	 * Stop the owned recording in response to a release edge. Safe to call when not
	 * holding (no-op), when startup is still in flight (latches a stop the start
	 * completion honors), and when the recording already ended (clears the stale
	 * session).
	 */
	async function stop(app: WhisperingApp) {
		if (!session || session.app !== app) return; // not this app's hold
		if (manualRecorder.state === 'RECORDING') return end(app, session.id);
		if (manualRecorder.isStarting) {
			session.stopRequested = true; // honored when start completes
			return;
		}
		clearSession(); // not recording and not starting: ended by other means
	}

	async function dispose(app: WhisperingApp): Promise<void> {
		if (!session || session.app !== app) return;
		if (pendingStart) {
			session.stopRequested = true;
			await pendingStart;
			return;
		}
		await end(app, session.id);
	}

	return { start, stop, dispose };
}

export const pushToTalk = createPushToTalk();
