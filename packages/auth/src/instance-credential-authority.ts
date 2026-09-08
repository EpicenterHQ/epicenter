import { INSTANCE_PRINCIPAL_ID } from '@epicenter/principal';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch, ConnectionStatus } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import type { AuthIdentityState } from './auth-identity-state.js';
import type { BearerAuthorization } from './credential-authority.js';
import { readApiSession } from './read-api-session.js';

const InstanceAuthorityError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Instance credential subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type InstanceCredentialAuthorityDependencies = {
	fetch?: AuthFetch;
	log?: Logger;
};

export type InstanceCredentialAuthorityOptions = {
	baseURL: string;
	token: string;
};

export type InstanceCredentialSnapshot = {
	state: AuthIdentityState;
	connectionStatus: ConnectionStatus;
	networkEligible: boolean;
	tokenGeneration: number;
};

/**
 * Own one static self-host credential without owning its application transport.
 *
 * The authority verifies the token through `/api/session`, keeps the instance
 * principal available during an outage, and compares rejection reports against
 * the generation that authorized the failed request. It deliberately owns no
 * persistence, OAuth launcher, refresh, or revocation behavior.
 */
export function createInstanceCredentialAuthority(
	{
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
		log = createLogger('auth/instance-credential-authority'),
	}: InstanceCredentialAuthorityDependencies,
	{ baseURL, token }: InstanceCredentialAuthorityOptions,
) {
	let state: AuthIdentityState = {
		status: 'signed-in',
		principalId: INSTANCE_PRINCIPAL_ID,
	};
	let connectionStatus: ConnectionStatus = 'connecting';
	let tokenGeneration = 1;
	let verificationFlight:
		| {
				tokenGeneration: number;
				promise: Promise<Result<undefined, AuthError>>;
		  }
		| undefined;
	let currentSnapshot = createSnapshot();
	const changeListeners = new Set<
		(snapshot: InstanceCredentialSnapshot) => void
	>();
	const stateListeners = new Set<(state: AuthIdentityState) => void>();
	const connectionListeners = new Set<(status: ConnectionStatus) => void>();

	function createSnapshot(): InstanceCredentialSnapshot {
		return {
			state,
			connectionStatus,
			networkEligible:
				state.status === 'signed-in' && connectionStatus === 'connected',
			tokenGeneration,
		};
	}

	function publish(previous: InstanceCredentialSnapshot) {
		const next = createSnapshot();
		if (snapshotsEqual(previous, next)) return;
		currentSnapshot = next;
		if (!authStatesEqual(previous.state, next.state)) {
			for (const listener of stateListeners) notify(listener, next.state);
		}
		if (previous.connectionStatus !== next.connectionStatus) {
			for (const listener of connectionListeners) {
				notify(listener, next.connectionStatus);
			}
		}
		for (const listener of changeListeners) notify(listener, next);
	}

	function notify<TValue>(listener: (value: TValue) => void, value: TValue) {
		try {
			listener(value);
		} catch (cause) {
			log.error(InstanceAuthorityError.SubscriberThrew({ cause }));
		}
	}

	function update(mutator: () => void) {
		const previous = currentSnapshot;
		mutator();
		publish(previous);
	}

	function deniedAuthorization(): BearerAuthorization {
		// Two facts, not one. A signed-out client holds no token at all. A
		// rejected one holds a token the box refused, and the repair is a person
		// entering a new one, which is exactly what `'reauth-required'` names.
		if (state.status === 'signed-out') {
			return { status: 'denied', code: 'signed-out' };
		}
		if (connectionStatus === 'rejected') {
			return { status: 'denied', code: 'reauth-required' };
		}
		return { status: 'denied', code: 'auth-unavailable' };
	}

	async function confirmSession(): Promise<Result<undefined, AuthError>> {
		const startedGeneration = tokenGeneration;
		if (verificationFlight?.tokenGeneration === startedGeneration) {
			return verificationFlight.promise;
		}
		update(() => {
			connectionStatus = 'connecting';
		});
		const promise = (async () => {
			const { data: session, error } = await readApiSession({
				baseURL,
				token,
				fetch: fetchImpl,
			});
			if (tokenGeneration !== startedGeneration) return Ok(undefined);
			if (error) {
				// A refused token is a CONNECTION fact and stays on the connection
				// channel. Writing `signed-out` here was a boot loop: this authority
				// boots optimistically `signed-in` as the instance principal, so
				// signed-in -> signed-out is a principal change, so a boot node's
				// `{#if}` flips, the next boot is optimistic again, and the page
				// spins at one `/api/session` round trip forever on any box whose
				// token was rotated. The reload gate is gone; the loop it caused is
				// still reachable through the keyed session, so this still matters. `authorize` below already refuses on either fact, so the
				// refusal is unchanged.
				update(() => {
					connectionStatus =
						error.name === 'Rejected' ? 'rejected' : 'unreachable';
				});
				return AuthError.StartSignInFailed({ cause: error });
			}
			update(() => {
				// Either refusal counts as the thing being recovered from, so a
				// generation minted here cannot be acted on by a `reportRejected`
				// still in flight for the credential that was refused.
				const wasRefused =
					state.status === 'signed-out' || connectionStatus === 'rejected';
				state = { status: 'signed-in', principalId: session.principalId };
				connectionStatus = 'connected';
				if (wasRefused) tokenGeneration += 1;
			});
			return Ok(undefined);
		})().finally(() => {
			if (verificationFlight?.tokenGeneration === startedGeneration) {
				verificationFlight = undefined;
			}
		});
		verificationFlight = { tokenGeneration: startedGeneration, promise };
		return promise;
	}

	async function authorize(): Promise<BearerAuthorization> {
		if (state.status === 'signed-out' || connectionStatus === 'rejected') {
			return deniedAuthorization();
		}
		if (connectionStatus !== 'connected') {
			const verification = await confirmSession();
			if (verification.error) return deniedAuthorization();
		}
		if (state.status !== 'signed-in' || connectionStatus !== 'connected') {
			return deniedAuthorization();
		}
		return {
			status: 'authorized',
			accessToken: token,
			tokenGeneration,
		};
	}

	function snapshotsEqual(
		left: InstanceCredentialSnapshot,
		right: InstanceCredentialSnapshot,
	) {
		return (
			authStatesEqual(left.state, right.state) &&
			left.connectionStatus === right.connectionStatus &&
			left.networkEligible === right.networkEligible &&
			left.tokenGeneration === right.tokenGeneration
		);
	}

	function authStatesEqual(left: AuthIdentityState, right: AuthIdentityState) {
		if (left.status !== right.status) return false;
		if (left.status === 'signed-out') return true;
		if (right.status === 'signed-out') return false;
		return left.principalId === right.principalId;
	}

	void confirmSession();

	return {
		baseURL,
		get snapshot(): InstanceCredentialSnapshot {
			return currentSnapshot;
		},
		onChange(fn: (snapshot: InstanceCredentialSnapshot) => void) {
			changeListeners.add(fn);
			return () => {
				changeListeners.delete(fn);
			};
		},
		onStateChange(fn: (state: AuthIdentityState) => void) {
			stateListeners.add(fn);
			return () => {
				stateListeners.delete(fn);
			};
		},
		onConnectionChange(fn: (status: ConnectionStatus) => void) {
			connectionListeners.add(fn);
			return () => {
				connectionListeners.delete(fn);
			};
		},
		startSignIn: confirmSession,
		async signOut() {
			update(() => {
				state = { status: 'signed-out' };
				tokenGeneration += 1;
			});
			return Ok(undefined);
		},
		authorize,
		reportRejected(generation: number) {
			if (generation !== tokenGeneration) return;
			// Same rule as the verification path: the token was refused, not the
			// person. `state` stays signed-in as the instance principal so the
			// local partition keeps its address and the reload gate stays quiet.
			update(() => {
				connectionStatus = 'rejected';
			});
		},
		[Symbol.dispose]() {
			changeListeners.clear();
			stateListeners.clear();
			connectionListeners.clear();
		},
	};
}

export type InstanceCredentialAuthority = ReturnType<
	typeof createInstanceCredentialAuthority
>;
