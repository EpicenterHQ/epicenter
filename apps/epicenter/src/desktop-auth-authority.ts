import {
	type AuthClient,
	AuthError,
	type AuthFetch,
	type AuthIdentityState,
	type ConnectionStatus,
	type PersistedAuthStorage,
	createInstanceAuth,
	createSerializedPersistedAuthStorage,
	createSessionAuth,
	createSessionHandoffClient,
	normalizeInstanceServer,
} from '@epicenter/auth';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { Ok } from 'wellcrafted/result';
import type { NativeAuthPort } from './sidecar-runtime.ts';

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;
const CALLBACK_URL = 'epicenter://auth/callback';

export type DesktopAuthBootSnapshot = {
	signInLocation?: 'host-settings';
	state: AuthIdentityState;
	connection: {
		baseURL: string;
		authorityId: string;
		status: ConnectionStatus;
	};
};

/**
 * Own the desktop session credential for one process generation.
 * Windows receive identity and use the captured boot Account through the
 * broker. A replacement is persisted for relaunch, never handed to old windows.
 */
export function createDesktopAuthAuthority({
	authCell,
	nativeAuthPort,
	fetch = globalThis.fetch.bind(globalThis),
}: {
	authCell: string | null;
	nativeAuthPort: NativeAuthPort;
	fetch?: AuthFetch;
}) {
	// Server selection is read once. Replacement cells only affect the next boot.
	let instanceServer: ReturnType<typeof normalizeInstanceServer> | undefined;
	let initial = authCell;
	try {
		const cell = JSON.parse(authCell ?? 'null');
		if (cell && typeof cell.server === 'string') {
			instanceServer = normalizeInstanceServer(cell.server);
			initial = JSON.stringify(cell.auth);
		}
	} catch {
		initial = null;
	}
	const baseURL = instanceServer?.baseURL ?? EPICENTER_API_URL;
	let writeTail = Promise.resolve();
	let currentCell = authCell;
	function writeCell(value: string | null, signal?: AbortSignal) {
		const pending = writeTail.then(async () => {
			signal?.throwIfAborted();
			await nativeAuthPort.storeAuth(value);
			if (signal?.aborted) {
				await nativeAuthPort.storeAuth(currentCell);
				signal.throwIfAborted();
			}
			currentCell = value;
		});
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
						instanceServer
							? JSON.stringify({
									server: baseURL,
									auth: serialized === null ? null : JSON.parse(serialized),
								})
							: serialized,
					),
	});
	const transaction = new Map<string, string>();
	const handoff = createSessionHandoffClient({
		baseURL: EPICENTER_API_URL,
		callback: CALLBACK_URL,
		fetch,
		storage: {
			getItem: (key) => transaction.get(key) ?? null,
			setItem: (key, value) => {
				transaction.set(key, value);
			},
		},
	});
	let callbackWaiter:
		| { accept(url: string): void; reject(cause: unknown): void }
		| undefined;
	// No unsolicited callback is queued for a future sign-in attempt.
	const stopCallbacks = nativeAuthPort.onAuthCallback((url) =>
		callbackWaiter?.accept(url),
	);
	const auth = instanceServer
		? createInstanceAuth({
				...instanceServer,
				fetch,
				persistedAuthStorage,
				async requestToken() {
					throw new Error('Enter your token in Home Settings.');
				},
			})
		: createSessionAuth({
				authorityId: 'epicenter-api',
				baseURL: EPICENTER_API_URL,
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
									cleanup();
									resolve(value);
								},
								reject(cause: unknown) {
									if (callbackWaiter === waiter) handoff.cancel();
									cleanup();
									reject(cause);
								},
							};
							const abort = () => waiter.reject(signal.reason);
							const timeout = setTimeout(() => {
								waiter.reject(
									new Error('Timed out waiting for desktop sign-in.'),
								);
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
	const account =
		auth.state.status === 'signed-out' ? null : auth.state.account;
	const bootSnapshot: DesktopAuthBootSnapshot = {
		...(instanceServer ? { signInLocation: 'host-settings' as const } : {}),
		state: projectBootIdentity(),
		connection: {
			baseURL,
			authorityId: instanceServer?.authorityId ?? 'epicenter-api',
			status: auth.connection.status,
		},
	};
	let signInFlight: ReturnType<typeof auth.startSignIn> | undefined;
	let disposed = false;
	let candidate: AuthClient | undefined;
	let selection: AbortController | undefined;
	let prepared = false;
	let preparing: Promise<void> | undefined;
	let resuming: Promise<void> | undefined;
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
		const current = auth.state;
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
					await writeCell(
						instanceServer
							? JSON.stringify({ server: baseURL, auth: null })
							: null,
					);
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

	async function selectCell(cell: string | null, signal: AbortSignal) {
		signal.throwIfAborted();
		// Sign-out retires the captured Account and drains its queued persistence.
		// Only then can the next boot's server and credential replace that cell.
		const released = await auth.signOut();
		if (released.error) throw released.error;
		signal.throwIfAborted();
		bootStorageRetired = true;
		await writeCell(cell, signal);
		signal.throwIfAborted();
		nativeAuthPort.relaunch();
	}

	function projectBootIdentity(): AuthIdentityState {
		const current = auth.state;
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
		selection?.abort();
		candidate?.[Symbol.dispose]();
		auth[Symbol.dispose]();
	}
	// EOF and protocol failure settle callback waiters as well as native RPCs.
	void nativeAuthPort.completed.then(dispose, dispose);

	return {
		baseURL,
		bootSnapshot,
		account,
		get state() {
			return projectBootIdentity();
		},
		async prepareConnection() {
			try {
				if (disposed || selection || signInFlight)
					throw new Error('Another connection operation is in progress.');
				await closeApplications();
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async cancelConnection() {
			if (disposed || selection || signInFlight || resuming)
				return AuthError.StartSignInFailed({
					cause: new Error('Wait for the connection operation to finish.'),
				});
			try {
				await recoverConnection();
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		startSignIn() {
			if (selection || resuming || bootStorageRetired)
				return Promise.resolve(
					AuthError.StartSignInFailed({
						cause: new Error('Restart Epicenter to use the selected server.'),
					}),
				);
			if (signInFlight) return signInFlight;
			const pending = Promise.resolve()
				.then(async () => {
					try {
						await closeApplications();
						if (disposed || signInFlight !== pending)
							throw new Error('Sign-in cancelled.');
						const result = await auth.startSignIn();
						if (signInFlight === pending && !disposed) {
							if (result.error) await recoverConnection();
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
		},
		async connectInstance(server: string, token: string) {
			if (disposed || !prepared || resuming || selection || signInFlight)
				return AuthError.StartSignInFailed({
					cause: new Error('Another connection operation is in progress.'),
				});
			const attempt = new AbortController();
			selection = attempt;
			try {
				const selected = normalizeInstanceServer(server);
				let verified: PersistedAuthStorage['initial'] = null;
				const next = createInstanceAuth({
					...selected,
					fetch,
					requestToken: async () => token,
					persistedAuthStorage: {
						initial: null,
						set(value) {
							verified = value;
						},
					},
				});
				candidate = next;
				const result = await next.startSignIn();
				if (result.error) return result;
				attempt.signal.throwIfAborted();
				await selectCell(
					JSON.stringify({ server: selected.baseURL, auth: verified }),
					attempt.signal,
				);
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			} finally {
				candidate?.[Symbol.dispose]();
				candidate = undefined;
				if (selection === attempt) selection = undefined;
			}
		},
		async selectHosted() {
			if (disposed || !prepared || resuming || selection || signInFlight)
				return AuthError.StartSignInFailed({
					cause: new Error('Another connection operation is in progress.'),
				});
			const attempt = new AbortController();
			selection = attempt;
			try {
				await selectCell(null, attempt.signal);
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			} finally {
				if (selection === attempt) selection = undefined;
			}
		},
		async signOut() {
			selection?.abort();
			candidate?.[Symbol.dispose]();
			candidate = undefined;
			signInFlight = undefined;
			try {
				await closeApplications();
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
			if (bootStorageRetired) {
				try {
					const selected = JSON.parse(currentCell ?? 'null');
					await writeCell(
						selected?.server
							? JSON.stringify({ server: selected.server, auth: null })
							: null,
					);
				} catch (cause) {
					return AuthError.SignOutFailed({ cause });
				}
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
