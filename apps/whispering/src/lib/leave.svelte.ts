/**
 * Answers the desktop shell when it asks to close the window or quit.
 *
 * Captured audio that has not reached the folder, a received transcript
 * whose file was not written, and a live recording exist only in this page,
 * and edits may still be being written. The shell cannot see them, so it asks
 * before closing and closes only on this page's `proceed`:
 *
 * - the moment a request arrives, before anything is awaited, the page stops
 *   admitting new work: no capture, request, retry, file change, or typing
 *   starts. What it then waits for and inspects is all there is;
 * - every request is acknowledged with `asking` before anything else, so the
 *   shell knows the page is alive and deciding;
 * - nothing is held once nothing is being written: `proceed`, with no prompt;
 * - something is held, or it could not be determined: the page shows its own
 *   confirmation. "Keep working" answers `cancel`, admits work again, and
 *   everything stays as it was. "Discard and quit" answers `proceed`.
 *
 * Sending `proceed` commits the quit. From then on nothing is admitted again
 * and "Keep working" is not offered, whether or not the answer arrived: a
 * reply that was lost may still have been taken. An answer that could not be
 * delivered leaves the page frozen with one action, quitting again.
 *
 * If Whispering's host has stopped, the shell cannot ask through it. The shell
 * then tells the page directly that a close was attempted, and the
 * confirmation appears with that explained. The window stays open until the
 * person chooses to quit: with no host to relay an answer, quitting is always
 * their explicit choice, even when nothing is held.
 *
 * A stopped host does not stop saving. The folder belongs to the shell and
 * stays open, so an edit is still written and a pending recording can still be
 * tried again once the person keeps working; what is held is read live, and
 * the prompt follows it. What the host did is what is gone: the terminal and
 * new transcription and transformation requests. A save can still fail for
 * its own reasons, as it can at any time.
 *
 * A browser tab has no shell to ask; there the browser's own leave warning
 * applies and this guard does nothing.
 */
import type { Workspace } from './workspace/types.js';

export type LeaveGuard = ReturnType<typeof createLeaveGuard>;

/**
 * - `idle`: nothing is being asked, and work is admitted.
 * - `preparing`: the shell asked; accepted saves are settling.
 * - `asking`: something is held, or the host is gone; the person chooses.
 * - `quitting`: the quit was sent, or is being sent. It is never undone.
 */
export type LeavePhase = 'idle' | 'preparing' | 'asking' | 'quitting';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export function createLeaveGuard(
	library: {
		prepareToLeave(): Promise<boolean>;
		readonly unsavedWork: readonly string[];
		pauseAdmission(): void;
		resumeAdmission(): void;
	},
	closing: Workspace['closing'],
) {
	let phase = $state<LeavePhase>('idle');
	/** The host is gone and cannot relay answers. The folder is still open. */
	let hostGone = $state(false);
	/** Whether a quit is being sent now. */
	let sending = $state(false);
	/** Why the last quit could not be confirmed as delivered. */
	let problem = $state<string | undefined>();
	/** The request being prepared. Keeping working, or the host going, makes it stale. */
	let preparing: object | undefined;
	/** The session is being closed. A guard that stopped listening approves nothing. */
	let disposed = false;

	// A lost acknowledgement changes nothing: the shell keeps waiting, and the
	// person still decides.
	const acknowledge = () => closing?.answer('asking').catch(() => {});

	async function requested() {
		if (closing === undefined || disposed) return;
		if (phase !== 'idle') {
			// Already deciding or quitting: acknowledged, and nothing changes.
			await acknowledge();
			return;
		}
		// Before anything is awaited: nothing new starts from here.
		phase = 'preparing';
		library.pauseAdmission();
		const request = {};
		preparing = request;
		// First, always: the page is here and has not agreed to anything.
		await acknowledge();
		let safe = false;
		try {
			safe = await library.prepareToLeave();
		} catch {
			// Not knowing what is held is treated as holding something.
		}
		// Disposed while finding out: the session is closing and saving on its
		// own, and this guard no longer speaks for it. Kept working, or the host
		// went away: this request decides nothing any more.
		if (disposed || preparing !== request) return;
		preparing = undefined;
		// With the host gone, quitting stays the person's choice.
		if (safe && !hostGone) await quit({ chosen: false });
		else phase = 'asking';
	}

	/** The shell tried to close but has no host to ask through. */
	function requestedWithoutHost() {
		hostGone = true;
		if (phase === 'idle') library.pauseAdmission();
		if (phase === 'idle' || phase === 'preparing') {
			preparing = undefined;
			phase = 'asking';
		}
	}

	/**
	 * Tell the shell to quit. Committed from the first line: nothing is admitted
	 * again, whatever happens to the answer.
	 *
	 * When the person `chose` to quit and the host did not take the answer, the
	 * quit address is used as well: the shell honors it only once its host is
	 * gone, and ignores it while the host lives.
	 */
	async function quit({ chosen }: { chosen: boolean }) {
		if (closing === undefined) return;
		phase = 'quitting';
		sending = true;
		problem = undefined;
		try {
			if (hostGone) {
				closing.quitWithoutHost();
				return;
			}
			try {
				await closing.answer('proceed');
			} catch (cause) {
				problem = describe(cause);
				if (chosen) closing.quitWithoutHost();
			}
		} finally {
			sending = false;
		}
	}

	const stops = [
		closing?.onRequest(() => void requested()),
		closing?.onRequestWithoutHost(requestedWithoutHost),
	];

	return {
		get phase() {
			return phase;
		},
		/** Whether the leave confirmation is showing. */
		get asking() {
			return phase === 'asking';
		},
		/** Whether the prompt is up because the host stopped. */
		get hostGone() {
			return hostGone;
		},
		/** Whether a quit is being sent now. */
		get sending() {
			return sending;
		},
		/** Why the last quit was not confirmed as delivered. The page stays frozen. */
		get problem() {
			return problem;
		},
		/** What closing now would lose. Read live, so the prompt follows saves. */
		get held() {
			return library.unsavedWork;
		},
		/** Stay open and admit work again. Not offered once the quit was sent. */
		async stay() {
			if (disposed) return;
			if (phase !== 'preparing' && phase !== 'asking') return;
			phase = 'idle';
			preparing = undefined;
			library.resumeAdmission();
			// A lost cancel leaves the shell's question open; it asks again, and
			// the page decides again.
			if (!hostGone) await closing?.answer('cancel').catch(() => {});
		},
		/**
		 * Close, dropping whatever is still held only in this window. After a
		 * quit that was sent, this is the one action left: send it again.
		 */
		async discardAndQuit() {
			if (disposed) return;
			if (phase === 'asking' || (phase === 'quitting' && !sending))
				await quit({ chosen: true });
		},
		dispose() {
			disposed = true;
			for (const stop of stops) stop?.();
		},
	};
}
