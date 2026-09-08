import {
	type AuthFetch,
	type AuthIdentityState,
	type ConnectionStatus,
	createOAuthAccount,
	createOAuthCredentialAuthority,
	createSerializedPersistedAuthStorage,
} from '@epicenter/auth';
import { createOAuthClient } from '@epicenter/auth/oauth-launchers';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
	EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth-clients';
import { Ok } from 'wellcrafted/result';
import type { NativeAuthPort } from './sidecar-runtime.ts';

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;

export type DesktopAuthBootSnapshot = {
	state: AuthIdentityState;
	connection: { baseURL: string; status: ConnectionStatus };
	networkEligible: boolean;
};

/**
 * Own the hosted desktop credential for one immutable process generation.
 *
 * Windows receive only the boot snapshot and use same-origin account broker
 * operations that never expose a bearer. Account changes persist the next cell
 * and relaunch.
 *
 * **One authority, named by this build.** The desktop reaches the authority
 * its bundle was built against and offers no way to point at another
 * (ADR-0326). The keychain cell is therefore the serialized credential and
 * nothing else: it carried a `deployment` discriminator only while a second
 * kind existed to select, and selecting one is what ADR-0325 refused.
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
	const oauthTransaction = new Map<string, string>();
	let queuedCallback: string | null = null;
	let callbackWaiter: ((url: string) => void) | null = null;
	const stopCallbacks = nativeAuthPort.onOAuthCallback((url) => {
		if (callbackWaiter === null) queuedCallback = url;
		else {
			const resolve = callbackWaiter;
			callbackWaiter = null;
			resolve(url);
		}
	});
	const oauthClient = createOAuthClient({
		issuer: `${EPICENTER_API_URL}/auth`,
		clientId: EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
		resource: EPICENTER_API_URL,
		fetch,
		storage: {
			getItem(key) {
				return oauthTransaction.get(key) ?? null;
			},
			setItem(key, value) {
				oauthTransaction.set(key, value);
			},
			removeItem(key) {
				oauthTransaction.delete(key);
			},
		},
	});
	const authority = createOAuthCredentialAuthority(
		{
			fetch,
			persistedAuthStorage: createSerializedPersistedAuthStorage({
				initial: authCell,
				write: (serialized) => nativeAuthPort.storeAuth(serialized),
			}),
			launcher: {
				async startSignIn() {
					const { data: url, error } = await oauthClient.createAuthorizationUrl(
						EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI,
					);
					if (error) return { data: null, error };
					await nativeAuthPort.openAuthUrl(url.toString());
					const callback = await waitForCallback();
					const grant = await oauthClient.exchangeCallback(callback);
					if (grant.error) return grant;
					return Ok({ status: 'completed', grant: grant.data } as const);
				},
			},
		},
		{
			baseURL: EPICENTER_API_URL,
			clientId: EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
		},
	);
	const account = createOAuthAccount(authority, { fetch });
	const bootSignal = authority.snapshot.accountSignal;
	const bootSnapshot = {
		state: authority.snapshot.state,
		connection: { baseURL: EPICENTER_API_URL, status: 'connected' as const },
		networkEligible: authority.snapshot.networkEligible,
	} satisfies DesktopAuthBootSnapshot;

	function waitForCallback(): Promise<string> {
		if (queuedCallback !== null) {
			const callback = queuedCallback;
			queuedCallback = null;
			return Promise.resolve(callback);
		}
		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (callbackWaiter !== settle) return;
				callbackWaiter = null;
				reject(new Error('Timed out waiting for the desktop OAuth callback.'));
			}, CALLBACK_TIMEOUT_MS);
			const settle = (url: string) => {
				clearTimeout(timeout);
				resolve(url);
			};
			callbackWaiter = settle;
		});
	}

	return {
		baseURL: EPICENTER_API_URL,
		bootSnapshot,
		account,
		get state(): AuthIdentityState {
			return bootSignal?.aborted
				? { status: 'signed-out' }
				: authority.snapshot.state;
		},
		async startSignIn() {
			const result = await authority.startSignIn();
			if (!result.error && authority.snapshot.state.status === 'signed-in') {
				nativeAuthPort.relaunch();
			}
			return result;
		},
		async signOut() {
			const result = await authority.signOut();
			if (!result.error) nativeAuthPort.relaunch();
			return result;
		},
		[Symbol.dispose]() {
			stopCallbacks();
			authority[Symbol.dispose]();
		},
	};
}

export type DesktopAuthAuthority = ReturnType<
	typeof createDesktopAuthAuthority
>;
