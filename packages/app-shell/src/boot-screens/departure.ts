import type { Account, AuthClient } from '@epicenter/auth';

/** One page can close once. Only a refusal before teardown permits another try. */
export function createDeparture({
	auth,
	account,
	close,
}: {
	auth?: Pick<AuthClient, 'onStateChange'>;
	account: Account | null;
	close: () => Promise<void>;
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
					await ui?.quiesce();
				} finally {
					await close();
				}
				publish(retired ? 'retired' : 'closed');
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
					if (retired)
						throw new Error('The account changed. Reopen the application.');
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
