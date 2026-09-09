import type { Account, AuthClient } from '@epicenter/auth';
import type { LibraryRetirement } from '@epicenter/data/store';

/** One page can close once. Only a refusal before teardown permits another try. */
export function createDeparture({
	auth,
	account,
	close,
	retirement,
	reload,
}: {
	auth?: Pick<AuthClient, 'onStateChange'>;
	account: Account | null;
	close: () => Promise<void>;
	retirement?: Promise<LibraryRetirement>;
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
	let retired = false;
	let closedSuccessfully = false;
	let library: LibraryRetirement | undefined;
	let invalidated: Promise<void> | undefined;
	let physicalCloseStarted = false;
	let uiQuiesced = false;
	let reloaded = false;
	function publish(phase: typeof state.phase, error: unknown = null) {
		state = { phase, error };
		for (const listener of listeners) listener();
	}
	function finish() {
		if (closing) return closing;
		closing = Promise.resolve().then(async () => {
			publish('checking');
			try {
				if (!retired) await ui?.preflight?.();
			} catch (error) {
				if (!retired) {
					closing = undefined;
					publish('open', error);
					throw error;
				}
			}
			publish('closing');
			try {
				try {
					if (!uiQuiesced) await ui?.quiesce();
					uiQuiesced = true;
				} catch (error) {
					// Retirement cannot release the library claim while a producer
					// still holds old references. Ordinary departure keeps its drain.
					if (library === undefined) await close();
					throw error;
				}
				if (library !== undefined) await invalidated;
				physicalCloseStarted = true;
				await close();
				closedSuccessfully = true;
				publish(retired ? 'retired' : 'closed');
				if (library !== undefined && !reloaded) {
					reloaded = true;
					reload?.();
				}
			} catch (error) {
				publish('failed', error);
				throw error;
			} finally {
				stopAuth();
			}
		});
		return closing;
	}
	const stopAuth =
		auth?.onStateChange((next) => {
			const nextAccount = next.status === 'signed-out' ? null : next.account;
			if (
				nextAccount === account ||
				state.phase === 'closed' ||
				state.phase === 'failed'
			)
				return;
			retired = true;
			// Auth already retired transport. This only finishes the local page.
			void finish().catch(() => {});
		}) ?? (() => {});
	void retirement?.then((notice) => {
		library = notice;
		invalidated = notice.invalidated;
		retired = true;
		if (state.phase === 'open' || state.phase === 'checking') publish('closing');
		void finish().catch(() => {});
	});
	return {
		/** Retry cleanup while the retired library's claim is still held. */
		get canRetryRetirement() {
			return (
				library !== undefined &&
				state.phase === 'failed' &&
				!physicalCloseStarted
			);
		},
		retryRetirement(): Promise<void> {
			if (
				library === undefined ||
				state.phase !== 'failed' ||
				physicalCloseStarted
			)
				return closing ?? Promise.resolve();
			invalidated = library.retryInvalidation();
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
					if (retired)
						throw new Error(
							library === undefined
								? 'The account changed. Reopen the application.'
								: 'The library was restored. Reload the application.',
						);
					publish('departing');
					await action();
				} catch (error) {
					if (state.phase === 'open' && !retired) departing = undefined;
					else publish('failed', error);
					throw error;
				}
			})();
			return departing;
		},
	};
}

export type Departure = ReturnType<typeof createDeparture>;
