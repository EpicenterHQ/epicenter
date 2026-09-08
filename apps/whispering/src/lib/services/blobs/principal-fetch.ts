import type { AuthClient, AuthFetch, AuthState } from '@epicenter/auth';
import type { PrincipalId } from '@epicenter/principal';

/** Keep a delayed blob request, including an auth retry, in its original account. */
export function createPrincipalFetch(
	client: Pick<AuthClient, 'state' | 'onStateChange' | 'fetch'>,
	principalId: PrincipalId,
): AuthFetch {
	return async (input, init) => {
		const controller = new AbortController();
		const check = (state: AuthState) => {
			if (state.status !== 'signed-in' || state.principalId !== principalId)
				controller.abort(
					new Error('The blob request account is no longer signed in.'),
				);
		};
		const unsubscribe = client.onStateChange(check);
		check(client.state);
		const callerSignal =
			init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const signal = callerSignal
			? AbortSignal.any([callerSignal, controller.signal])
			: controller.signal;
		try {
			signal.throwIfAborted();
			return await client.fetch(input, { ...init, signal });
		} finally {
			unsubscribe();
		}
	};
}
