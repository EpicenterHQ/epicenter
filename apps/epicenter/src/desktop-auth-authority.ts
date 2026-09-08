import {
	type AuthFetch,
	type AuthIdentityState,
	type ConnectionStatus,
	createSerializedPersistedAuthStorage,
	createSessionAuth,
	createSessionHandoffClient,
} from '@epicenter/auth';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import type { NativeAuthPort } from './sidecar-runtime.ts';

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;
const CALLBACK_URL = 'epicenter://auth/callback';

export type DesktopAuthBootSnapshot = {
	state: AuthIdentityState;
	connection: { baseURL: string; authorityId: string; status: ConnectionStatus };
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
	const auth = createSessionAuth({
		authorityId: 'epicenter-api',
		baseURL: EPICENTER_API_URL,
		fetch,
		persistedAuthStorage: createSerializedPersistedAuthStorage({
			initial: authCell,
			write: (serialized) => nativeAuthPort.storeAuth(serialized),
		}),
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
				return { status: 'completed', token: await handoff.complete(callback) };
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
		state: projectBootIdentity(),
		connection: { baseURL: EPICENTER_API_URL, authorityId: 'epicenter-api', status: auth.connection.status },
	};
	let signInFlight: ReturnType<typeof auth.startSignIn> | undefined;
	let disposed = false;

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
		auth[Symbol.dispose]();
	}
	// EOF and protocol failure settle callback waiters as well as native RPCs.
	void nativeAuthPort.completed.then(dispose, dispose);

	return {
		baseURL: EPICENTER_API_URL,
		bootSnapshot,
		account,
		get state() {
			return projectBootIdentity();
		},
		startSignIn() {
			if (signInFlight) return signInFlight;
			const pending = auth
				.startSignIn()
				.then((result) => {
					if (!result.error && !disposed && signInFlight === pending)
						nativeAuthPort.relaunch();
					return result;
				})
				.finally(() => {
					if (signInFlight === pending) signInFlight = undefined;
				});
			signInFlight = pending;
			return pending;
		},
		async signOut() {
			signInFlight = undefined;
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
