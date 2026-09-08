import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import type { AuthIdentityState } from './auth-identity-state.js';
import type {
	ApiSessionResponse,
	OAuthTokenGrant,
	PersistedAuth,
} from './auth-types.js';
import type { BearerAuthorization } from './credential-authority.js';
import type {
	CallbackOAuthLauncher,
	OAuthLauncher,
} from './oauth-launchers/contract.js';
import {
	refreshOAuthTokenWithEndpoint,
	revokeOAuthRefreshTokenWithEndpoint,
} from './oauth-token-endpoints.js';
import type { PersistedAuthStorage } from './persisted-auth-storage.js';
import {
	type ApiSessionReadError,
	readApiSession,
} from './read-api-session.js';

const REFRESH_SKEW_MS = 60_000;

type NetworkAccess = 'unverified' | 'verified' | 'paused';

type RuntimeAuthIdentityState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			persistedAuth: PersistedAuth;
			networkAccess: NetworkAccess;
	  };

type RefreshFlight = {
	persistedAuth: PersistedAuth;
	promise: Promise<boolean>;
};

type IdentityVerificationFlight = {
	persistedAuth: PersistedAuth;
	promise: Promise<ApiSessionReadResult>;
};

type ApiSessionReadResult = Result<ApiSessionResponse, ApiSessionReadError>;

const AuthIdentityStateChangeError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Auth state subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type OAuthCredentialAuthorityDependencies = {
	persistedAuthStorage: PersistedAuthStorage;
	launcher: OAuthLauncher;
	fetch?: AuthFetch;
	log?: Logger;
};

export type OAuthCredentialAuthorityOptions = {
	baseURL?: string;
	clientId: string;
	now?: () => number;
};

export type OAuthCredentialSnapshot = {
	state: AuthIdentityState;
	/** Identity and cancellation for this uninterrupted account attachment. */
	accountSignal: AbortSignal | null;
	networkEligible: boolean;
	tokenGeneration: number;
};

/**
 * Own one hosted OAuth credential cell without owning an application transport.
 *
 * The authority serializes persistence, refresh, session verification,
 * sign-in, sign-out, and stale-rejection handling. Callers ask for a scoped
 * bearer grant, then perform their own HTTP or WebSocket operation. This lets a
 * browser client and the Epicenter Bun host share credential semantics without
 * proxying application bytes through the authority.
 */
export function createOAuthCredentialAuthority(
	{
		persistedAuthStorage,
		launcher,
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
		log = createLogger('auth/oauth-credential-authority'),
	}: OAuthCredentialAuthorityDependencies,
	{
		baseURL = EPICENTER_API_URL,
		clientId,
		now = Date.now,
	}: OAuthCredentialAuthorityOptions,
) {
	const authSession = createAuthSessionRuntime({
		initialPersistedAuth: persistedAuthStorage.initial,
		persistedAuthStorage,
		log,
	});
	let refreshFlight: RefreshFlight | null = null;
	let identityVerificationFlight: IdentityVerificationFlight | null = null;
	let signInFlight: Promise<Result<undefined, AuthError>> | null = null;
	let signInGeneration = 0;
	let disposed = false;

	function beginSignInGeneration() {
		signInGeneration += 1;
		return signInGeneration;
	}

	function isCurrentSignIn(generation: number) {
		return !disposed && signInGeneration === generation;
	}

	function cancelInFlightSignIn() {
		signInGeneration += 1;
		signInFlight = null;
	}

	async function clearAuthSession() {
		refreshFlight = null;
		identityVerificationFlight = null;
		await authSession.clear();
	}

	async function clearPersistedAuth() {
		cancelInFlightSignIn();
		await clearAuthSession();
	}

	async function refreshGrant(force: boolean): Promise<boolean> {
		const startedFrom = authSession.persistedAuth;
		if (startedFrom === null || authSession.networkAuthPaused) return false;
		if (
			!force &&
			startedFrom.grant.accessTokenExpiresAt > now() + REFRESH_SKEW_MS
		) {
			return true;
		}
		if (refreshFlight?.persistedAuth === startedFrom) {
			return refreshFlight.promise;
		}

		const promise = (async () => {
			try {
				const { data: grant, error } = await refreshOAuthTokenWithEndpoint({
					baseURL,
					clientId,
					grant: startedFrom.grant,
					fetch: fetchImpl,
					now,
				});
				if (error !== null) {
					if (disposed || authSession.persistedAuth !== startedFrom)
						return false;
					// ONLY a refusal pauses. This used to be a bare `catch` that
					// paused on anything the endpoint threw, so a tunnel, a DNS
					// hiccup, or a 502 dropped a signed-in person to
					// `reauth-required` and told them to sign in again. Everything
					// but `Rejected` is a condition the next attempt can survive,
					// and the grant on disk is still the best one we have.
					//
					// The sibling read got this right first: `readApiSession`
					// pauses on `Rejected` alone and has since it was written.
					// This is that rule, arriving at the second of the two places
					// that needed it.
					if (error.name === 'Rejected') authSession.pauseNetworkAuth();
					log.error(AuthError.RefreshGrantFailed({ cause: error }));
					return false;
				}
				if (disposed || authSession.persistedAuth !== startedFrom) return false;
				const next = {
					grant,
					principalId: startedFrom.principalId,
				} satisfies PersistedAuth;
				await authSession.write(next);
				if (disposed || authSession.persistedAuth !== startedFrom) return false;
				authSession.replaceUnverified(next);
				return true;
			} catch (cause) {
				// `authSession.write` is the only thing left that can throw here,
				// and a storage failure is not a credential failure either.
				if (!disposed && authSession.persistedAuth === startedFrom) {
					log.error(AuthError.RefreshGrantFailed({ cause }));
				}
				return false;
			} finally {
				if (refreshFlight?.persistedAuth === startedFrom) {
					refreshFlight = null;
				}
			}
		})();
		refreshFlight = { persistedAuth: startedFrom, promise };

		return promise;
	}

	async function verifyPersistedAuthForNetwork(
		startedFrom: PersistedAuth,
	): Promise<ApiSessionReadResult> {
		if (identityVerificationFlight?.persistedAuth === startedFrom) {
			return identityVerificationFlight.promise;
		}
		const promise = (async (): Promise<ApiSessionReadResult> => {
			const { data: session, error } = await readApiSession({
				baseURL,
				fetch: fetchImpl,
				token: startedFrom.grant.accessToken,
			});
			if (error) {
				if (
					error.name === 'Rejected' &&
					!disposed &&
					authSession.persistedAuth === startedFrom
				) {
					authSession.pauseNetworkAuth();
				}
				return Err(error);
			}
			const current = authSession.persistedAuth;
			if (disposed || current !== startedFrom) return Ok(session);

			if (current.principalId !== session.principalId) {
				await clearPersistedAuth();
				return Ok(session);
			}

			authSession.markVerified();
			return Ok(session);
		})().finally(() => {
			if (identityVerificationFlight?.persistedAuth === startedFrom) {
				identityVerificationFlight = null;
			}
		});
		identityVerificationFlight = { persistedAuth: startedFrom, promise };

		return promise;
	}

	function deniedAuthorization(): BearerAuthorization {
		if (authSession.persistedAuth === null) {
			return { status: 'denied', code: 'signed-out' };
		}
		if (authSession.networkAuthPaused) {
			return { status: 'denied', code: 'reauth-required' };
		}
		return { status: 'denied', code: 'auth-unavailable' };
	}

	async function authorize(
		forceRefresh: boolean,
		expectedAccount: AbortSignal | null,
	): Promise<BearerAuthorization> {
		const isCurrent = () =>
			expectedAccount !== null &&
			!expectedAccount.aborted &&
			authSession.snapshot.accountSignal === expectedAccount;
		if (!isCurrent()) return { status: 'denied', code: 'signed-out' };
		if (authSession.persistedAuth === null || authSession.networkAuthPaused)
			return deniedAuthorization();
		const refreshed = await refreshGrant(forceRefresh);
		if (!isCurrent()) return { status: 'denied', code: 'signed-out' };
		const refreshedPersistedAuth = authSession.persistedAuth;
		if (
			!refreshed ||
			refreshedPersistedAuth === null ||
			authSession.networkAuthPaused
		) {
			return deniedAuthorization();
		}
		let verifiedPersistedAuth = authSession.verifiedPersistedAuth;
		if (verifiedPersistedAuth === null) {
			const verification = await verifyPersistedAuthForNetwork(
				refreshedPersistedAuth,
			);
			if (!isCurrent()) return { status: 'denied', code: 'signed-out' };
			if (verification.error) return deniedAuthorization();
			verifiedPersistedAuth = authSession.verifiedPersistedAuth;
			if (verifiedPersistedAuth === null) return deniedAuthorization();
		}
		return {
			status: 'authorized',
			accessToken: verifiedPersistedAuth.grant.accessToken,
			tokenGeneration: authSession.tokenGeneration,
		};
	}

	/**
	 * Run one sign-in attempt as THE sign-in attempt.
	 *
	 * Both halves of sign-in share this and share the flight it holds, which is
	 * what makes a second caller join rather than start a rival: two
	 * `startSignIn` clicks are one launch, and a callback route that mounts twice
	 * is one exchange rather than an authorization code spent and then replayed.
	 *
	 * The generation is what a superseded attempt checks itself against. Every
	 * `await` inside an attempt is a place a sign-out or a newer attempt can
	 * land, and an attempt that finds itself stale answers `Ok` and installs
	 * nothing rather than writing an identity nobody asked for any more.
	 */
	function runSignInFlight(
		attempt: (generation: number) => Promise<Result<undefined, AuthError>>,
		fail: (args: { cause: unknown }) => Result<never, AuthError>,
	): Promise<Result<undefined, AuthError>> {
		if (disposed)
			return Promise.resolve(fail({ cause: 'Auth client disposed.' }));
		if (signInFlight !== null) return signInFlight;
		const generation = beginSignInGeneration();
		const promise = (async () => {
			try {
				return await attempt(generation);
			} catch (cause) {
				if (!isCurrentSignIn(generation)) return Ok(undefined);
				return fail({ cause });
			}
		})().finally(() => {
			if (signInFlight === promise) signInFlight = null;
		});
		signInFlight = promise;
		return promise;
	}

	/**
	 * Verify a grant, install it, and publish, or answer with `fail`.
	 *
	 * The failure variant is a parameter because both halves of sign-in end
	 * here and they are not the same failure: a launch that could not be
	 * started is repaired by starting again, and a callback that could not be
	 * finished is not.
	 */
	async function installGrant(
		grant: OAuthTokenGrant,
		generation: number,
		fail: (args: { cause: unknown }) => Result<never, AuthError>,
	): Promise<Result<undefined, AuthError>> {
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		const previous = authSession.persistedAuth;
		const { data: session, error } = await readApiSession({
			baseURL,
			fetch: fetchImpl,
			token: grant.accessToken,
		});
		if (error) {
			return fail({ cause: error });
		}
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		if (previous !== null && previous.principalId !== session.principalId) {
			await clearAuthSession();
			if (!isCurrentSignIn(generation)) return Ok(undefined);
		}
		const next = {
			grant,
			principalId: session.principalId,
		} satisfies PersistedAuth;
		await authSession.write(next);
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		authSession.replaceVerified(next);
		return Ok(undefined);
	}

	return {
		baseURL,
		get snapshot(): OAuthCredentialSnapshot {
			return authSession.snapshot;
		},
		onChange(fn: (snapshot: OAuthCredentialSnapshot) => void) {
			return authSession.onChange(fn);
		},
		onStateChange(fn: (state: AuthIdentityState) => void) {
			return authSession.onStateChange(fn);
		},
		startSignIn() {
			return runSignInFlight(async (generation) => {
				const result = await launcher.startSignIn();
				if (!isCurrentSignIn(generation)) return Ok(undefined);
				if (result.error) {
					return AuthError.StartSignInFailed({ cause: result.error });
				}
				switch (result.data?.status) {
					case 'launched':
						return Ok(undefined);
					case 'completed':
						return installGrant(
							result.data.grant,
							generation,
							AuthError.StartSignInFailed,
						);
				}
				return AuthError.StartSignInFailed({
					cause: { message: 'OAuth launcher returned no launch result.' },
				});
			}, AuthError.StartSignInFailed);
		},
		/**
		 * Finish the sign-in this runtime's callback carries.
		 *
		 * `undefined` when the launcher cannot complete a callback, which is what
		 * `createOAuthAppAuth` reads to decide whether the client it composes is
		 * a `CallbackAuthClient`. An extension launcher completes inside its own
		 * `startSignIn` and never returns to a redirect URI, so there is nothing
		 * here for it to do.
		 *
		 * It shares `signInFlight` with `startSignIn` on purpose. A callback route
		 * that mounts twice joins the one exchange rather than spending the
		 * authorization code and then failing on the replay, and a callback
		 * landing while a launch is still in flight supersedes it, because
		 * beginning a generation is what cancels the previous one.
		 */
		completeSignIn: canCompleteCallback(launcher)
			? () =>
					runSignInFlight(async (generation) => {
						const result = await launcher.completeSignIn();
						if (!isCurrentSignIn(generation)) return Ok(undefined);
						// Narrowed on `data` rather than on `error`, because a launcher
						// states its failures as `unknown` and an `unknown` that is not
						// null narrows nothing.
						if (result.data === null) {
							return AuthError.CompleteSignInFailed({ cause: result.error });
						}
						return installGrant(
							result.data,
							generation,
							AuthError.CompleteSignInFailed,
						);
					}, AuthError.CompleteSignInFailed)
			: undefined,
		async signOut() {
			try {
				const refreshTokenToRevoke =
					authSession.persistedAuth?.grant.refreshToken;
				await clearPersistedAuth();
				if (refreshTokenToRevoke) {
					void revokeOAuthRefreshTokenWithEndpoint({
						baseURL,
						clientId,
						refreshToken: refreshTokenToRevoke,
						fetch: fetchImpl,
					}).catch(() => undefined);
				}
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		authorize({
			forceRefresh = false,
			accountSignal = authSession.snapshot.accountSignal,
		}: {
			forceRefresh?: boolean;
			accountSignal?: AbortSignal | null;
		} = {}) {
			return authorize(forceRefresh, accountSignal);
		},
		reportRejected(tokenGeneration: number) {
			if (authSession.tokenGeneration !== tokenGeneration) return;
			authSession.pauseNetworkAuth();
		},
		[Symbol.dispose]() {
			disposed = true;
			cancelInFlightSignIn();
			authSession.dispose();
		},
	};
}

export type OAuthCredentialAuthority = ReturnType<
	typeof createOAuthCredentialAuthority
>;

/** Whether this launcher is the kind that comes back to a redirect URI. */
function canCompleteCallback(
	launcher: OAuthLauncher,
): launcher is CallbackOAuthLauncher {
	return (
		typeof (launcher as Partial<CallbackOAuthLauncher>).completeSignIn ===
		'function'
	);
}

function createAuthSessionRuntime({
	initialPersistedAuth,
	persistedAuthStorage,
	log,
}: {
	initialPersistedAuth: PersistedAuth | null;
	persistedAuthStorage: PersistedAuthStorage;
	log: Logger;
}) {
	let runtimeState: RuntimeAuthIdentityState =
		initialPersistedAuth === null
			? { status: 'signed-out' }
			: {
					status: 'signed-in',
					persistedAuth: initialPersistedAuth,
					networkAccess: 'unverified',
				};
	let tokenGeneration = initialPersistedAuth === null ? 0 : 1;
	let accountLifetime =
		initialPersistedAuth === null ? null : new AbortController();
	let currentSnapshot = snapshotFromRuntime(
		runtimeState,
		tokenGeneration,
		accountLifetime?.signal ?? null,
	);
	let storageWriteQueue: Promise<void> = Promise.resolve();
	const changeListeners = new Set<
		(snapshot: OAuthCredentialSnapshot) => void
	>();
	const stateChangeListeners = new Set<(state: AuthIdentityState) => void>();

	function publish() {
		const next = snapshotFromRuntime(
			runtimeState,
			tokenGeneration,
			accountLifetime?.signal ?? null,
		);
		if (credentialSnapshotsEqual(currentSnapshot, next)) return;
		const stateChanged = !authStatesEqual(currentSnapshot.state, next.state);
		currentSnapshot = next;
		if (stateChanged) {
			for (const listener of stateChangeListeners) {
				try {
					listener(next.state);
				} catch (error) {
					log.error(
						AuthIdentityStateChangeError.SubscriberThrew({ cause: error }),
					);
				}
			}
		}
		for (const listener of changeListeners) {
			try {
				listener(next);
			} catch (error) {
				log.error(
					AuthIdentityStateChangeError.SubscriberThrew({ cause: error }),
				);
			}
		}
	}

	async function write(value: PersistedAuth | null) {
		const pendingWrite = storageWriteQueue.then(() =>
			persistedAuthStorage.set(value),
		);
		storageWriteQueue = pendingWrite.catch(() => undefined);
		await pendingWrite;
	}

	function replace(persistedAuth: PersistedAuth, networkAccess: NetworkAccess) {
		accountLifetime ??= new AbortController();
		runtimeState = { status: 'signed-in', persistedAuth, networkAccess };
		tokenGeneration += 1;
		publish();
	}

	return {
		get snapshot() {
			return currentSnapshot;
		},
		get persistedAuth(): PersistedAuth | null {
			return runtimeState.status === 'signed-out'
				? null
				: runtimeState.persistedAuth;
		},
		get networkAuthPaused() {
			return (
				runtimeState.status === 'signed-in' &&
				runtimeState.networkAccess === 'paused'
			);
		},
		get verifiedPersistedAuth(): PersistedAuth | null {
			if (runtimeState.status === 'signed-out') return null;
			if (runtimeState.networkAccess !== 'verified') return null;
			return runtimeState.persistedAuth;
		},
		get tokenGeneration() {
			return tokenGeneration;
		},
		onChange(fn: (snapshot: OAuthCredentialSnapshot) => void) {
			changeListeners.add(fn);
			return () => {
				changeListeners.delete(fn);
			};
		},
		onStateChange(fn: (state: AuthIdentityState) => void) {
			stateChangeListeners.add(fn);
			return () => {
				stateChangeListeners.delete(fn);
			};
		},
		replaceUnverified(persistedAuth: PersistedAuth) {
			replace(persistedAuth, 'unverified');
		},
		replaceVerified(persistedAuth: PersistedAuth) {
			replace(persistedAuth, 'verified');
		},
		markVerified() {
			if (
				runtimeState.status === 'signed-out' ||
				runtimeState.networkAccess === 'verified'
			) {
				return;
			}
			runtimeState = { ...runtimeState, networkAccess: 'verified' };
			publish();
		},
		pauseNetworkAuth() {
			if (
				runtimeState.status === 'signed-out' ||
				runtimeState.networkAccess === 'paused'
			) {
				return;
			}
			runtimeState = { ...runtimeState, networkAccess: 'paused' };
			publish();
		},
		async write(value: PersistedAuth | null) {
			await write(value);
		},
		async clear() {
			if (runtimeState.status !== 'signed-out') {
				runtimeState = { status: 'signed-out' };
				const retired = accountLifetime;
				accountLifetime = null;
				retired?.abort();
				tokenGeneration += 1;
				publish();
			}
			await write(null);
		},
		dispose() {
			accountLifetime?.abort();
			changeListeners.clear();
			stateChangeListeners.clear();
		},
	};
}

function snapshotFromRuntime(
	runtimeState: RuntimeAuthIdentityState,
	tokenGeneration: number,
	accountSignal: AbortSignal | null,
): OAuthCredentialSnapshot {
	return {
		state: publicStateFromRuntime(runtimeState),
		accountSignal,
		networkEligible:
			runtimeState.status === 'signed-in' &&
			runtimeState.networkAccess === 'verified',
		tokenGeneration,
	};
}

function publicStateFromRuntime(
	runtimeState: RuntimeAuthIdentityState,
): AuthIdentityState {
	if (runtimeState.status === 'signed-out') return { status: 'signed-out' };
	if (runtimeState.networkAccess === 'paused') {
		return {
			status: 'reauth-required',
			principalId: runtimeState.persistedAuth.principalId,
		};
	}
	return {
		status: 'signed-in',
		principalId: runtimeState.persistedAuth.principalId,
	};
}

function credentialSnapshotsEqual(
	left: OAuthCredentialSnapshot,
	right: OAuthCredentialSnapshot,
) {
	return (
		authStatesEqual(left.state, right.state) &&
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
