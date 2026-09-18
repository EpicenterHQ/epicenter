import type { Account, AuthClient } from '@epicenter/auth';

/** Quiesce page producers before closing resources; retry only unfinished cleanup. */
export function createDeparture({
	auth,
	account,
	close,
	libraryReplaced,
	canRetryClose,
	reload,
}: {
	auth?: Pick<AuthClient, 'onStateChange'>;
	account?: Account;
	close: () => Promise<void>;
	libraryReplaced?: Promise<void>;
	canRetryClose?: () => boolean;
	reload?: () => void;
}) {
	let state: {
		phase:
			| 'open'
			| 'checking'
			| 'closing'
			| 'closed'
			| 'departing'
			| 'retired'
			| 'failed';
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
	let uiQuiesced = false;
	let reloaded = false;
	function publish(phase: typeof state.phase, error: unknown = null) {
		state = { phase, error };
		for (const listener of listeners) listener();
	}
	function finish() {
		if (closing) return closing;
		const retrying = state.phase === 'failed';
		closing = Promise.resolve().then(async () => {
			publish('checking');
			try {
				if (endedBy === undefined && !retrying) await ui?.preflight?.();
			} catch (error) {
				if (endedBy === undefined) {
					closing = undefined;
					publish('open', error);
					throw error;
				}
			}
			publish('closing');
			try {
				if (!uiQuiesced) await ui?.quiesce();
				uiQuiesced = true;
				await close();
				closedSuccessfully = true;
				publish(endedBy ? 'retired' : 'closed');
				if (endedBy === 'library' && !reloaded) {
					reloaded = true;
					reload?.();
				}
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
			const nextAccount = next.status === 'signed-out' ? undefined : next.account;
			if (nextAccount === account || state.phase === 'closed') return;
			endedBy = 'account';
			if (state.phase === 'failed') return;
			// Auth already retired transport. This only finishes the local page.
			void finish().catch(() => {});
		}) ?? (() => {});
	void libraryReplaced?.then(() => {
		// Account replacement closes this page without automatically reopening it.
		if (endedBy !== 'account') endedBy = 'library';
		if (state.phase === 'open' || state.phase === 'checking')
			publish('closing');
		void finish().catch(() => {});
	});
	function retryable() {
		return (
			state.phase === 'failed' && (!uiQuiesced || canRetryClose?.() === true)
		);
	}
	return {
		/** Retry only when UI cleanup or the resource owner can still make progress. */
		get canRetryClose() {
			return retryable();
		},
		retryClose(): Promise<void> {
			if (!retryable()) return closing ?? Promise.resolve();
			closing = undefined;
			return finish();
		},
		/** Navigation after failure is safe only when producers and storage closed. */
		get canReopen() {
			return closedSuccessfully;
		},
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
