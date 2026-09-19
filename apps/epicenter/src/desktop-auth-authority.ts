import {
	AuthError,
	type AuthFetch,
	type AuthIdentityState,
	type AuthServer,
	createSerializedPersistedAuthStorage,
	createSessionAuth,
	createSessionHandoffClient,
	parsePersistedAuth,
} from '@epicenter/auth';
import type { DesktopAuthBootstrap } from '@epicenter/auth/desktop';
import { Ok, type Result } from 'wellcrafted/result';
import type { NativeAuthPort } from './sidecar-runtime.ts';

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;
const CALLBACK_URL = 'epicenter://auth/callback';

/** Own credentials for the configured server and one desktop process generation. */
export function createDesktopAuthAuthority({
	authCell,
	nativeAuthPort,
	server,
	fetch = globalThis.fetch.bind(globalThis),
	callbackUrl = CALLBACK_URL,
}: {
	authCell: string | null;
	nativeAuthPort: NativeAuthPort;
	server: AuthServer;
	fetch?: AuthFetch;
	callbackUrl?: string;
}) {
	const { baseURL, authorityId, supportsShared } = server;
	// Retain the stored envelope; it validates credentials, never selects a server.
	const method = server.accountManagement ? 'cloud' : 'issuer';
	let initial: string | null = null;
	let credentialUnreadable = false;
	try {
		const cell = authCell === null ? null : JSON.parse(authCell);
		if (cell !== null && cell.auth !== null) {
			if (cell.method !== method || cell.origin !== new URL(baseURL).origin)
				throw new Error('Saved credentials do not belong to this deployment.');
			const credential = parsePersistedAuth(JSON.stringify(cell.auth) ?? null);
			if (credential === null) throw new Error('Invalid saved credential.');
			initial = JSON.stringify(credential);
		}
	} catch {
		credentialUnreadable = true;
	}
	let writeTail = Promise.resolve();
	function writeCell(value: string | null) {
		const pending = writeTail.then(() => nativeAuthPort.storeAuth(value));
		writeTail = pending.catch(() => {});
		return pending;
	}
	let bootStorageRetired = false;
	const persistedAuthStorage = createSerializedPersistedAuthStorage({
		initial,
		write: (serialized) =>
			bootStorageRetired
				? undefined
				: writeCell(
						serialized === null
							? null
							: JSON.stringify({
									method,
									origin: new URL(baseURL).origin,
									auth: JSON.parse(serialized),
								}),
					),
	});
	const transaction = new Map<string, string>();
	const handoff = createSessionHandoffClient({
		baseURL,
		callback: callbackUrl,
		fetch,
		storage: {
			getItem: (key) => transaction.get(key) ?? null,
			setItem: (key, value) => {
				transaction.set(key, value);
			},
		},
	});
	let callbackWaiter:
		| { accept(url: string): boolean; reject(cause: unknown): void }
		| undefined;
	// No unsolicited callback is queued for a future sign-in attempt.
	function acceptSignInCallback(url: string) {
		return callbackWaiter?.accept(url) ?? false;
	}
	const stopCallbacks = nativeAuthPort.onAuthCallback(acceptSignInCallback);
	const auth = createSessionAuth({
		authorityId,
		supportsShared,
		baseURL,
		fetch,
		persistedAuthStorage,
		launcher: {
			async startSignIn({ signal, reauthenticate }) {
				signal.throwIfAborted();
				const url = await handoff.begin();
				signal.throwIfAborted();
				if (reauthenticate) url.searchParams.set('reauth', '1');
				const callback = await new Promise<string>((resolve, reject) => {
					const cleanup = () => {
						clearTimeout(timeout);
						signal.removeEventListener('abort', abort);
						if (callbackWaiter === waiter) callbackWaiter = undefined;
					};
					const waiter = {
						accept(value: string) {
							let destination: URL;
							try {
								destination = new URL(value);
							} catch {
								return false;
							}
							const state = destination.searchParams.get('state');
							destination.search = '';
							if (
								destination.href !== callbackUrl ||
								state !== url.searchParams.get('state')
							)
								return false;
							cleanup();
							resolve(value);
							return true;
						},
						reject(cause: unknown) {
							if (callbackWaiter === waiter) handoff.cancel();
							cleanup();
							reject(cause);
						},
					};
					const abort = () => waiter.reject(signal.reason);
					const timeout = setTimeout(() => {
						waiter.reject(new Error('Timed out waiting for desktop sign-in.'));
					}, CALLBACK_TIMEOUT_MS);
					callbackWaiter = waiter;
					signal.addEventListener('abort', abort, { once: true });
					// Install cancellation before starting the asynchronous opener.
					// Its acknowledgement must not hold a cancelled waiter open.
					void Promise.resolve()
						.then(() => {
							signal.throwIfAborted();
							return nativeAuthPort.openAuthUrl(url.href);
						})
						.catch(waiter.reject);
				});
				// The shared core owns installation and any orphan token revocation.
				return {
					status: 'completed',
					token: await handoff.complete(callback),
				};
			},
			cancel() {
				callbackWaiter?.reject(
					new DOMException('Sign-in cancelled.', 'AbortError'),
				);
				handoff.cancel();
			},
		},
	});
	const account = auth.getState().account ?? null;
	const bootSnapshot: DesktopAuthBootstrap = {
		state: projectBootIdentity(),
		server,
		credentialUnreadable,
	};
	let signInFlight: Promise<Result<undefined, AuthError>> | undefined;
	let disposed = false;
	let prepared = false;
	let preparing: Promise<void> | undefined;
	let resuming: Promise<void> | undefined;
	let cancelling: Promise<Result<undefined, AuthError>> | undefined;
	function closeApplications() {
		if (resuming)
			return Promise.reject(new Error('Applications are resuming. Try again.'));
		if (prepared) return Promise.resolve();
		if (preparing) return preparing;
		const pending = nativeAuthPort
			.closeApplications()
			.then(() => {
				if (disposed) throw new Error('The desktop closed.');
				prepared = true;
			})
			.finally(() => {
				if (preparing === pending) preparing = undefined;
			});
		preparing = pending;
		return pending;
	}
	function resumeApplications() {
		if (resuming) return resuming;
		prepared = false;
		const pending = Promise.resolve()
			.then(async () => {
				await preparing?.catch(() => {});
				// Preparation may have completed while cancellation waited for it.
				prepared = false;
				await nativeAuthPort.resumeApplications();
			})
			.finally(() => {
				if (resuming === pending) resuming = undefined;
			});
		resuming = pending;
		return pending;
	}

	async function recoverConnection() {
		const current = auth.getState();
		if (
			bootStorageRetired ||
			(account !== null &&
				(current.status === 'signed-out' || current.account !== account))
		) {
			// Retired boot identities cannot reopen their old documents. Clear
			// only the original server's identity, then start a fresh process.
			const pending = closeApplications()
				.then(async () => {
					bootStorageRetired = true;
					await writeCell(null);
					if (!disposed) nativeAuthPort.relaunch();
				})
				.finally(() => {
					if (resuming === pending) resuming = undefined;
				});
			resuming = pending;
			await pending;
		} else {
			await resumeApplications();
		}
	}
	function projectBootIdentity(): AuthIdentityState {
		const current = auth.getState();
		if (
			account === null ||
			current.status === 'signed-out' ||
			current.account !== account
		)
			return { status: 'signed-out' };
		return { status: current.status, principalId: account.principalId };
	}

	function dispose() {
		if (disposed) return;
		disposed = true;
		stopCallbacks();
		auth[Symbol.dispose]();
	}
	// EOF and protocol failure settle callback waiters as well as native RPCs.
	void nativeAuthPort.completed.then(dispose, dispose);

	function startSignIn(options?: { reauthenticate?: boolean }) {
		if (disposed || resuming || cancelling || bootStorageRetired)
			return Promise.resolve(
				AuthError.StartSignInFailed({
					cause: new Error('Restart Epicenter before signing in again.'),
				}),
			);
		if (signInFlight) return signInFlight;
		const pending = Promise.resolve()
			.then(async () => {
				try {
					await closeApplications();
					if (disposed || cancelling || signInFlight !== pending)
						throw new Error('Sign-in cancelled.');
					const result = await auth.startSignIn(options);
					if (signInFlight === pending && !disposed && !cancelling) {
						if (result.error) await recoverConnection();
						else if (
							account !== null &&
							auth.getState().status !== 'signed-out' &&
							auth.getState().account === account
						)
							await resumeApplications();
						else nativeAuthPort.relaunch();
					}
					return result;
				} catch (cause) {
					return AuthError.StartSignInFailed({ cause });
				}
			})
			.finally(() => {
				if (signInFlight === pending) signInFlight = undefined;
			});
		signInFlight = pending;
		return pending;
	}

	return {
		baseURL,
		callbackUrl,
		acceptSignInCallback,
		bootSnapshot,
		account,
		getState() {
			return projectBootIdentity();
		},
		cancelConnection() {
			if (cancelling) return cancelling;
			if (disposed || resuming)
				return Promise.resolve(
					AuthError.StartSignInFailed({
						cause: new Error('Wait for the connection operation to finish.'),
					}),
				);
			const pending = signInFlight;
			const cancellation = Promise.resolve()
				.then(async () => {
					try {
						await auth.cancelSignIn();
						await pending;
						if (disposed) throw new Error('The desktop closed.');
						await recoverConnection();
						return Ok(undefined);
					} catch (cause) {
						return AuthError.StartSignInFailed({ cause });
					}
				})
				.finally(() => {
					if (cancelling === cancellation) cancelling = undefined;
				});
			cancelling = cancellation;
			return cancellation;
		},
		startSignIn,
		async signOut() {
			if (cancelling)
				return AuthError.SignOutFailed({
					cause: new Error('Sign-in cancellation is pending.'),
				});
			signInFlight = undefined;
			try {
				await closeApplications();
				if (bootStorageRetired) await writeCell(null);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
			const result = await auth.signOut();
			if (!result.error && !disposed) nativeAuthPort.relaunch();
			return result;
		},
		[Symbol.dispose]: dispose,
	};
}

export type DesktopAuthAuthority = ReturnType<
	typeof createDesktopAuthAuthority
>;
