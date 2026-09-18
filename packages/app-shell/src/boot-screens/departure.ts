import type { Account, AuthClient } from '@epicenter/auth';

/** Quiesce page producers before closing resources; a failed lifetime requires page teardown. */
export function createDeparture({
	auth,
	account,
	preflight,
	quiesce,
	opening,
}: {
	auth?: Pick<AuthClient, 'onStateChange'>;
	account?: Account;
	preflight?: () => Promise<void>;
	quiesce?: () => Promise<void>;
	opening?: Promise<{ signal: AbortSignal; close(): Promise<void> }>;
}) {
	let state: {
		phase: 'open' | 'closing' | 'closed' | 'retired' | 'failed';
		error: unknown;
	} = { phase: 'open', error: null };
	const listeners = new Set<() => void>();
	let closing: Promise<void> | undefined;
	let departing: Promise<void> | undefined;
	let endedBy: 'account' | 'data' | 'unmount' | undefined;
	let closedSuccessfully = false;
	let stopRetirement: (() => void) | undefined;

	function publish(phase: typeof state.phase, error: unknown = null) {
		state = { phase, error };
		for (const listener of listeners) listener();
	}
	function finish() {
		if (closing) return closing;
		closing = Promise.resolve().then(async () => {
			try {
				if (endedBy === undefined) await preflight?.();
			} catch (error) {
				if (endedBy === undefined) {
					closing = undefined;
					publish('open', error);
					throw error;
				}
			}
			publish('closing');
			try {
				await quiesce?.();
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
				endedBy ??= 'data';
				void finish().catch(() => {});
			};
			if (signal.aborted) retired();
			else {
				signal.addEventListener('abort', retired, { once: true });
				stopRetirement = () => signal.removeEventListener('abort', retired);
			}
		},
		() => {},
	);
	return {
		getState() {
			return state;
		},
		onChange(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Used by native close acknowledgments as well as deliberate departures. */
		close: finish,
		/** Teardown cannot be vetoed and must suppress a pending navigation. */
		abandon() {
			endedBy ??= 'unmount';
			return finish();
		},
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
								: endedBy === 'data'
									? 'The data was replaced. Reload the application.'
									: 'The application page closed.',
						);
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
