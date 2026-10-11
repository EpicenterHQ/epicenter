import {
	AuthError,
	type AuthFetch,
	type AuthIdentityState,
	type AuthServer,
	createSerializedPersistedAuthStorage,
	createSessionAuth,
	createSessionHandoffClient,
	parsePersistedAuth,
	readApiSession,
	revokeSession,
} from '@epicenter/auth';
import type { DesktopAuthBootstrap } from '@epicenter/auth/desktop';
import { Ok, type Result } from 'wellcrafted/result';
import type { NativeAuthPort, RelaunchGrant } from './sidecar-runtime.ts';

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;
const CALLBACK_URL = 'epicenter://auth/callback';

/**
 * One boot Account. Explicit authentication prepares credentials for a new process.
 *
 * Changing accounts restarts every page the host serves, so it first asks Rust
 * for a restart (`prepareRelaunch`). Rust grants it without asking the pages;
 * they flush their saves in flight when the grant is finished. Until the
 * grant arrives, the current authority, cell, and credential keep working,
 * and a refusal costs only the candidate. After the grant the change is
 * committed: dispose, write the cell, revoke the replaced credential, restart.
 */
export function createDesktopAuthAuthority({
	authCell,
	nativeAuthPort,
	server,
	accountManagement,
	fetch = globalThis.fetch.bind(globalThis),
	callbackUrl = CALLBACK_URL,
}: {
	authCell: string | null;
	nativeAuthPort: NativeAuthPort;
	server: AuthServer;
	accountManagement: boolean;
	fetch?: AuthFetch;
	callbackUrl?: string;
}) {
	const { baseURL, authorityId } = server;
	let initial: string | null = null;
	let credentialUnreadable = false;
	try {
		const cell = authCell === null ? null : JSON.parse(authCell);
		if (cell !== null && cell.auth !== null) {
			if (
				cell.origin !== new URL(baseURL).origin ||
				(cell.method !== undefined &&
					cell.method !== 'cloud' &&
					cell.method !== 'issuer')
			)
				throw new Error('Saved credentials do not belong to this deployment.');
			const credential = parsePersistedAuth(JSON.stringify(cell.auth) ?? null);
			if (credential === null) throw new Error('Invalid saved credential.');
			initial = JSON.stringify(credential);
		}
	} catch {
		credentialUnreadable = true;
	}
	const bootCredential = parsePersistedAuth(initial);
	let writeTail = Promise.resolve();
	function writeCell(serialized: string | null) {
		const value =
			serialized === null
				? null
				: JSON.stringify({
						origin: new URL(baseURL).origin,
						auth: JSON.parse(serialized),
					});
		const pending = writeTail.then(() => nativeAuthPort.storeAuth(value));
		writeTail = pending.catch(() => {});
		return pending;
	}
	const auth = createSessionAuth({
		authorityId,
		baseURL,
		fetch,
		persistedAuthStorage: createSerializedPersistedAuthStorage({
			initial,
			write: writeCell,
		}),
		launcher: {
			async startSignIn() {
				throw new Error('Desktop sign-in belongs to the next process.');
			},
		},
	});
	const account = auth.getState().account ?? null;
	function projectBootIdentity(): AuthIdentityState {
		const current = auth.getState();
		return current.status === 'signed-out'
			? { status: 'signed-out' }
			: { status: current.status, principalId: current.account.principalId };
	}
	const bootSnapshot: DesktopAuthBootstrap = {
		state: projectBootIdentity(),
		server,
		accountManagement,
		credentialUnreadable,
	};
	let disposed = false;
	/** Aborted by disposal, so owners of the boot Account's work retire with it. */
	const lifetime = new AbortController();
	/**
	 * A relaunch preparation is outstanding. Set before its first await, so one
	 * account change at a time reaches Rust: synchronous disposal used to give
	 * this serialization, and disposal now waits for the pages to agree.
	 */
	let replacing = false;
	const anotherChange = () =>
		new Error(
			'Another account change is still in progress. Try again in a moment.',
		);
	const restartFirst = () =>
		new Error('Restart Epicenter before changing accounts again.');
	let attempt:
		| {
				controller: AbortController;
				promise: Promise<Result<undefined, AuthError>>;
				resolve(result: Result<undefined, AuthError>): void;
		  }
		| undefined;
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
	function acceptSignInCallback(url: string) {
		return callbackWaiter?.accept(url) ?? false;
	}
	const stopCallbacks = nativeAuthPort.onAuthCallback(acceptSignInCallback);
	function cancelAttempt() {
		const pending = attempt;
		attempt = undefined;
		pending?.controller.abort();
		handoff.cancel();
		pending?.resolve(
			AuthError.StartSignInFailed({ cause: new Error('Sign-in cancelled.') }),
		);
	}
	function dispose() {
		if (disposed) return;
		disposed = true;
		lifetime.abort();
		cancelAttempt();
		stopCallbacks();
		auth[Symbol.dispose]();
	}
	void nativeAuthPort.completed.then(dispose, dispose);
	const revoke = (token: string) => revokeSession({ baseURL, token, fetch });

	/** Commit an account change the pages agreed to. Runs once per process. */
	async function replaceProcess(
		next: ReturnType<typeof parsePersistedAuth>,
		grant: RelaunchGrant,
	) {
		// Acceptance is synchronous. Disposal fences transport without writing storage.
		// A prior verification write already entered writeTail or fails its owner check.
		dispose();
		try {
			await writeCell(next === null ? null : JSON.stringify(next));
		} catch (cause) {
			// A failed write may have changed storage. Never resume or claim its
			// contents: this process stays restart-required. The pages it held
			// for the restart resume.
			grant.abort();
			const token = next?.token ?? bootCredential?.token;
			if (token) await revoke(token);
			throw cause;
		}
		if (bootCredential && bootCredential.token !== next?.token)
			await revoke(bootCredential.token);
		grant.relaunch();
	}

	async function launch(signal: AbortSignal, reauthenticate: boolean) {
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
					const destination = URL.parse(value);
					if (!destination) return false;
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
			const timeout = setTimeout(
				() =>
					waiter.reject(new Error('Timed out waiting for desktop sign-in.')),
				CALLBACK_TIMEOUT_MS,
			);
			callbackWaiter = waiter;
			signal.addEventListener('abort', abort, { once: true });
			void Promise.resolve()
				.then(() => {
					signal.throwIfAborted();
					return nativeAuthPort.openAuthUrl(url.href);
				})
				.catch(waiter.reject);
		});
		return handoff.complete(callback);
	}

	return {
		baseURL,
		callbackUrl,
		acceptSignInCallback,
		bootSnapshot,
		account,
		/** Aborts once, when this authority and its boot Account are disposed. */
		signal: lifetime.signal,
		get restartRequired() {
			return (
				disposed ||
				(account !== null && auth.getState().status === 'signed-out')
			);
		},
		getState: projectBootIdentity,
		async cancelConnection() {
			if (disposed)
				return AuthError.StartSignInFailed({
					cause: new Error('Restart Epicenter to continue.'),
				});
			cancelAttempt();
			return Ok(undefined);
		},
		startSignIn({
			reauthenticate = auth.getState().status === 'reauth-required',
		} = {}) {
			if (disposed)
				return Promise.resolve(
					AuthError.StartSignInFailed({
						cause: new Error('Restart Epicenter before signing in again.'),
					}),
				);
			if (attempt) return attempt.promise;
			if (replacing)
				return Promise.resolve(
					AuthError.StartSignInFailed({ cause: anotherChange() }),
				);
			const pending = {
				controller: new AbortController(),
				...Promise.withResolvers<Result<undefined, AuthError>>(),
			};
			attempt = pending;
			void (async () => {
				let token: string | undefined;
				let accepted = false;
				let preparing = false;
				try {
					const signal = pending.controller.signal;
					token = await launch(signal, reauthenticate);
					signal.throwIfAborted();
					const { data: session, error: sessionError } = await readApiSession({
						baseURL,
						token,
						fetch,
						signal,
					});
					signal.throwIfAborted();
					if (sessionError) throw sessionError;
					if (disposed || attempt !== pending)
						throw new Error('Sign-in was superseded.');
					if (replacing) throw anotherChange();
					replacing = true;
					preparing = true;
					const grant = await nativeAuthPort.prepareRelaunch(signal);
					// A cancellation or sign-out that won the race keeps the current
					// authority: give the grant back before anything is accepted.
					if (signal.aborted || disposed || attempt !== pending) {
						grant.abort();
						throw new Error('Sign-in was superseded.');
					}
					// Detach before disposal so cancellation cannot override an accepted result.
					attempt = undefined;
					accepted = true;
					await replaceProcess(
						{ token, principalId: session.principalId },
						grant,
					);
					pending.resolve(Ok(undefined));
				} catch (cause) {
					if (preparing && !accepted) replacing = false;
					if (token && !accepted) await revoke(token);
					pending.resolve(AuthError.StartSignInFailed({ cause }));
				} finally {
					if (attempt === pending) attempt = undefined;
				}
			})();
			return pending.promise;
		},
		async signOut() {
			if (disposed) return AuthError.SignOutFailed({ cause: restartFirst() });
			// Sign-out wins over a sign-in still in progress. One already asking
			// Rust to restart is withdrawn, and this asks for a retry rather than
			// run a second preparation beside it.
			cancelAttempt();
			if (replacing) return AuthError.SignOutFailed({ cause: anotherChange() });
			replacing = true;
			let grant: RelaunchGrant;
			try {
				grant = await nativeAuthPort.prepareRelaunch();
			} catch (cause) {
				replacing = false;
				return AuthError.SignOutFailed({ cause });
			}
			if (disposed) {
				grant.abort();
				return AuthError.SignOutFailed({ cause: restartFirst() });
			}
			try {
				await replaceProcess(null, grant);
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		[Symbol.dispose]: dispose,
	};
}
export type DesktopAuthAuthority = ReturnType<
	typeof createDesktopAuthAuthority
>;
