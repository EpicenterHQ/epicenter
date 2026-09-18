import type { Account, AuthClient } from '@epicenter/auth';

/** Quiesce page producers before closing resources; a failed lifetime requires page teardown. */
export function createDeparture({
	auth,
	account,
	beforeClose,
	opening,
}: {
	auth?: Pick<AuthClient, 'onStateChange'>;
	account?: Account;
	beforeClose?: () => void | Promise<void>;
	opening?: Promise<{ signal: AbortSignal; close(): Promise<void> }>;
}) {
	let state: {
		phase:
			| 'open'
			| 'checking'
			| 'closing'
			| 'closed'
			| 'departing'
			| 'retired'
			| 'failed'
			| 'opening-failed';
		error: unknown;
	} = { phase: 'open', error: null };
	const listeners = new Set<() => void>();
	let ui:
		| {
				preflight?: () => Promise<void>;
				quiesce: () => Promise<void>;
		  }
		| undefined;
	let closing: Promise<void> | undefined;
	let departing: Promise<void> | undefined;
	let endedBy: 'account' | 'library' | undefined;
	let closedSuccessfully = false;
	let stopRetirement: (() => void) | undefined;

	function publish(phase: typeof state.phase, error: unknown = null) {
		// Opening failure remains terminal even when departure was already underway.
		if (state.phase === 'opening-failed') return;
		state = { phase, error };
		for (const listener of listeners) listener();
	}
	function finish() {
		if (closing) return closing;
		if (state.phase === 'opening-failed') return Promise.reject(state.error);
		closing = Promise.resolve().then(async () => {
			publish('checking');
			try {
				if (endedBy === undefined) await ui?.preflight?.();
			} catch (error) {
				if (endedBy === undefined) {
					closing = undefined;
					publish('open', error);
					throw error;
				}
			}
			publish('closing');
			try {
				await ui?.quiesce();
				await beforeClose?.();
				const app = await opening;
				// No await separates detaching retirement from App's synchronous revocation.
				stopRetirement?.();
				await app?.close();
				closedSuccessfully = true;
				publish(endedBy ? 'retired' : 'closed');
			} catch (error) {
				publish('failed', error);
				throw error;
			} finally {
				if (closedSuccessfully) stopAuth();
			}
		});
		return closing;
	}
	const stopAuth =
		auth?.onStateChange((next) => {
			if (next.account === account || state.phase === 'closed') return;
			endedBy = 'account';
			if (state.phase === 'failed') return;
			// Auth already retired transport. This only finishes the local page.
			void finish().catch(() => {});
		}) ?? (() => {});
	void opening?.then(
		({ signal }) => {
			const retired = () => {
				if (closedSuccessfully) return;
				endedBy ??= 'library';
				void finish().catch(() => {});
			};
			if (signal.aborted) retired();
			else {
				signal.addEventListener('abort', retired, { once: true });
				stopRetirement = () => signal.removeEventListener('abort', retired);
			}
		},
		(error) => publish('opening-failed', error),
	);
	return {
		get state() {
			return state;
		},
		onChange(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Register the mounted page's DOM and producer cleanup before rendering it. */
		attachUi(callbacks: NonNullable<typeof ui>) {
			if (state.phase !== 'open') return;
			if (ui) throw new Error('This page already has a UI owner.');
			ui = callbacks;
		},
		/** Used by native close acknowledgments as well as deliberate departures. */
		close: finish,
		/** The first request owns the action; later requests share its result. */
		go(action: () => Promise<void> | void) {
			if (departing) return departing;
			departing = (async () => {
				try {
					await finish();
					if (endedBy)
						throw new Error(
							endedBy === 'account'
								? 'The account changed. Reopen the application.'
								: 'The library was restored. Reload the application.',
						);
					publish('departing');
					await action();
				} catch (error) {
					if (state.phase === 'open' && endedBy === undefined)
						departing = undefined;
					else publish('failed', error);
					throw error;
				}
			})();
			return departing;
		},
	};
}

export type Departure = ReturnType<typeof createDeparture>;
