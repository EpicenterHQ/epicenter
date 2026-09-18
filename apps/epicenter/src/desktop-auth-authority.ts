import {
	AuthError,
	type AuthFetch,
	type AuthIdentityState,
	createAccountManagementUrl,
	createInstanceAuth,
	createSerializedPersistedAuthStorage,
	createSessionAuth,
	createSessionHandoffClient,
	normalizeInstanceServer,
	parsePersistedAuth,
} from '@epicenter/auth';
import type { DesktopAuthBootstrap } from '@epicenter/auth/desktop';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { Ok, type Result } from 'wellcrafted/result';
import type { NativeAuthPort } from './sidecar-runtime.ts';

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;
const CALLBACK_URL = 'epicenter://auth/callback';

/**
 * Own the desktop session credential for one process generation.
 * Windows receive identity and use the captured boot Account through the
 * broker. A replacement is persisted for relaunch, never handed to old windows.
 */
export function createDesktopAuthAuthority({
	authCell,
	nativeAuthPort,
	fetch = globalThis.fetch.bind(globalThis),
	callbackUrl = CALLBACK_URL,
}: {
	authCell: string | null;
	nativeAuthPort: NativeAuthPort;
	fetch?: AuthFetch;
	callbackUrl?: string;
}) {
	// Server selection is read once. Replacement cells only affect the next boot.
	// Legacy instance cells keep their static principal; issuer selection starts
	// a separate named session without assigning that principal's data to a user.
	let instanceServer: ReturnType<typeof normalizeInstanceServer> | undefined;
	let initial: string | null = null;
	let method: 'cloud' | 'issuer' | 'instance' | 'recovery' = 'cloud';
	try {
		if (authCell !== null) {
			const cell = JSON.parse(authCell);
			if (
				!cell ||
				(cell.method !== 'cloud' &&
					cell.method !== 'instance' &&
					cell.method !== 'issuer') ||
				typeof cell.origin !== 'string'
			)
				throw new Error('Invalid saved server selection.');
			const selected = normalizeInstanceServer(cell.origin);
			if (
				selected.baseURL !== cell.origin ||
				(cell.method === 'cloud' &&
					cell.origin !== new URL(EPICENTER_API_URL).origin) ||
				(cell.method === 'issuer' &&
					cell.origin === new URL(EPICENTER_API_URL).origin)
			)
				throw new Error('Saved credentials belong to another server.');
			const credential = parsePersistedAuth(JSON.stringify(cell.auth) ?? null);
			if (cell.auth !== null && credential === null)
				throw new Error('Invalid saved credential.');
			if (
				cell.method === 'instance' &&
				credential !== null &&
				credential.principalId !== 'instance'
			)
				throw new Error('Invalid instance principal.');
			method = cell.method;
			instanceServer = method === 'cloud' ? undefined : selected;
			initial = credential === null ? null : JSON.stringify(credential);
		}
	} catch {
		method = 'recovery';
		instanceServer = undefined;
		initial = null;
	}
	const baseURL = instanceServer?.baseURL ?? EPICENTER_API_URL;
	const emptyCell = () =>
		method === 'instance' || method === 'issuer'
			? JSON.stringify({ method, origin: baseURL, auth: null })
			: null;
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
			bootStorageRetired || method === 'recovery'
				? undefined
				: writeCell(
						serialized === null
							? emptyCell()
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
	const auth =
		method === 'recovery'
			? null
			: method === 'instance' && instanceServer
				? createInstanceAuth({
						...instanceServer,
						fetch,
						persistedAuthStorage,
					})
				: Object.assign(
						createSessionAuth({
							authorityId: instanceServer?.authorityId ?? 'epicenter-api',
							supportsShared: instanceServer !== undefined,
							baseURL,
							fetch,
							persistedAuthStorage,
							launcher: {
								async startSignIn({ signal, reauthenticate }) {
									signal.throwIfAborted();
									const url = await handoff.begin();
									signal.throwIfAborted();
									if (reauthenticate) url.searchParams.set('reauth', '1');
									const callback = await new Promise<string>(
										(resolve, reject) => {
											const cleanup = () => {
												clearTimeout(timeout);
												signal.removeEventListener('abort', abort);
												if (callbackWaiter === waiter)
													callbackWaiter = undefined;
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
										},
									);
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
						}),
						method === 'cloud'
							? { accountManagementUrl: createAccountManagementUrl }
							: {},
					);
	const account =
		!auth || auth.state.status === 'signed-out' ? null : auth.state.account;
	const bootSnapshot: DesktopAuthBootstrap = {
		...(method === 'instance' || method === 'recovery'
			? { signInLocation: 'host-settings' as const }
			: {}),
		state: projectBootIdentity(),
		baseURL,
		authorityId: instanceServer?.authorityId ?? 'epicenter-api',
		selectedServer: instanceServer?.baseURL ?? null,
		recovery: method === 'recovery',
		startSignIn: method === 'cloud' || method === 'issuer',
		accountManagement: method === 'cloud',
	};
	let signInFlight: Promise<Result<undefined, AuthError>> | undefined;
	let disposed = false;
	let selection: AbortController | undefined;
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
		const current = auth?.state;
		if (
			bootStorageRetired ||
			(account !== null &&
				(!current ||
					current.status === 'signed-out' ||
					current.account !== account))
		) {
			// Retired boot identities cannot reopen their old documents. Clear
			// only the original server's identity, then start a fresh process.
			const pending = closeApplications()
				.then(async () => {
					bootStorageRetired = true;
					await writeCell(emptyCell());
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
		const released = await auth?.signOut();
		if (released?.error) throw released.error;
		signal.throwIfAborted();
		bootStorageRetired = true;
		await writeCell(cell, signal);
		signal.throwIfAborted();
		nativeAuthPort.relaunch();
	}

	function projectBootIdentity(): AuthIdentityState {
		const current = auth?.state;
		if (
			account === null ||
			!current ||
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
		auth?.[Symbol.dispose]();
	}
	// EOF and protocol failure settle callback waiters as well as native RPCs.
	void nativeAuthPort.completed.then(dispose, dispose);

	function startSignIn(options?: { reauthenticate?: boolean }) {
		if (
			(method !== 'cloud' && method !== 'issuer') ||
			disposed ||
			selection ||
			resuming ||
			cancelling ||
			bootStorageRetired
		)
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
					if (disposed || cancelling || signInFlight !== pending)
						throw new Error('Sign-in cancelled.');
					if (!auth || !('startSignIn' in auth))
						throw new Error('Sign-in is unavailable.');
					const result = await auth.startSignIn(options);
					if (signInFlight === pending && !disposed && !cancelling) {
						if (result.error) await recoverConnection();
						else if (
							account !== null &&
							auth.state.status !== 'signed-out' &&
							auth.state.account === account
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
		get state() {
			return projectBootIdentity();
		},
		cancelConnection() {
			if (cancelling) return cancelling;
			if (disposed || selection || resuming)
				return Promise.resolve(
					AuthError.StartSignInFailed({
						cause: new Error('Wait for the connection operation to finish.'),
					}),
				);
			const pending = signInFlight;
			const cancellation = Promise.resolve()
				.then(async () => {
					try {
						if (auth && 'cancelSignIn' in auth) await auth.cancelSignIn();
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
		async connectInstance(server: string) {
			if (disposed || resuming || cancelling || selection || signInFlight)
				return AuthError.StartSignInFailed({
					cause: new Error('Another connection operation is in progress.'),
				});
			const attempt = new AbortController();
			selection = attempt;
			try {
				const selected = normalizeInstanceServer(server);
				if (selected.baseURL === new URL(EPICENTER_API_URL).origin)
					throw new Error('Use Epicenter Cloud to connect to this server.');
				attempt.signal.throwIfAborted();
				await closeApplications();
				await selectCell(
					JSON.stringify({
						method: 'issuer',
						origin: selected.baseURL,
						auth: null,
					}),
					attempt.signal,
				);
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			} finally {
				if (selection === attempt) selection = undefined;
			}
		},
		async useCloud() {
			if (method === 'cloud' && !bootStorageRetired) return startSignIn();
			if (disposed || resuming || cancelling || selection || signInFlight)
				return AuthError.StartSignInFailed({
					cause: new Error('Another connection operation is in progress.'),
				});
			const attempt = new AbortController();
			selection = attempt;
			try {
				await closeApplications();
				await selectCell(null, attempt.signal);
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			} finally {
				if (selection === attempt) selection = undefined;
			}
		},
		async signOut() {
			if (cancelling)
				return AuthError.SignOutFailed({
					cause: new Error('Sign-in cancellation is pending.'),
				});
			selection?.abort();
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
						selected?.method === 'instance' || selected?.method === 'issuer'
							? JSON.stringify({
									method: selected.method,
									origin: selected.origin,
									auth: null,
								})
							: null,
					);
				} catch (cause) {
					return AuthError.SignOutFailed({ cause });
				}
			}
			const result = (await auth?.signOut()) ?? Ok(undefined);
			if (!result.error && !disposed) nativeAuthPort.relaunch();
			return result;
		},
		[Symbol.dispose]: dispose,
	};
}

export type DesktopAuthAuthority = ReturnType<
	typeof createDesktopAuthAuthority
>;
