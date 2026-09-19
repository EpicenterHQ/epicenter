import type { Account, AuthClient } from '@epicenter/auth';

/** AppBoot owns this lifetime; teardown interrupts vetoes but never skips producer drains. */
export function createPageLifetime({
	auth,
	account,
	preflight,
	stopUi,
	opening,
}: {
	auth: Pick<AuthClient, 'onStateChange'> | undefined;
	account: Account | undefined;
	preflight: (hasEnded: () => boolean) => Promise<void>;
	stopUi: (voluntary: boolean) => Promise<void>;
	opening: Promise<{ signal: AbortSignal; close(): Promise<void> }>;
}) {
	let state = $state.raw<{
		phase: 'open' | 'closing' | 'closed' | 'retired' | 'failed';
		error: unknown;
	}>({ phase: 'open', error: null });
	let closing: Promise<void> | undefined;
	let departing: Promise<void> | undefined;
	let endedBy: 'account' | 'data' | 'unmount' | undefined;
	const forced = Promise.withResolvers<void>();
	let closedSuccessfully = false;
	let stopRetirement: (() => void) | undefined;

	function setState(phase: typeof state.phase, error: unknown = null) {
		state = { phase, error };
	}
	function finish() {
		if (closing) return closing;
		closing = Promise.resolve().then(async () => {
			try {
				if (endedBy === undefined)
					await Promise.race([
						preflight(() => endedBy !== undefined),
						forced.promise,
					]);
			} catch (error) {
				if (endedBy === undefined) {
					closing = undefined;
					setState('open', error);
					throw error;
				}
			}
			setState('closing');
			try {
				await stopUi(endedBy === undefined);
				const app = await opening;
				// No await separates detaching retirement from App's synchronous revocation.
				stopRetirement?.();
				await app.close();
				closedSuccessfully = true;
				setState(endedBy ? 'retired' : 'closed');
			} catch (error) {
				setState('failed', error);
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
			forced.resolve();
			if (state.phase === 'failed') return;
			// Auth already retired transport. This only finishes the local page.
			void finish().catch(() => {});
		}) ?? (() => {});
	void opening.then(
		({ signal }) => {
			const retired = () => {
				if (closedSuccessfully) return;
				endedBy ??= 'data';
				forced.resolve();
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
		get state() {
			return state;
		},
		/** Used by native close acknowledgments as well as deliberate departures. */
		close: finish,
		/** Teardown cannot be vetoed and must suppress a pending navigation. */
		abandon() {
			endedBy ??= 'unmount';
			forced.resolve();
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
					else setState('failed', error);
					throw error;
				}
			})();
			return departing;
		},
	};
}

export type Leave = (action: () => Promise<void> | void) => Promise<void>;
