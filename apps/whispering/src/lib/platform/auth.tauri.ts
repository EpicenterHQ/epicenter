/**
 * Sign-in with Epicenter in Whispering's desktop app: `#platform/auth` under
 * the `tauri` condition. It is for hosted transcription and AI only;
 * signing in never changes where Whispering keeps its files (decision 77).
 *
 * The shell owns the sign-in (`src-tauri/src/account.rs`): the person signs
 * in in their own browser, which returns to a loopback redirect, and the
 * refresh token stays in the operating system's credential store. This page
 * holds no credential: each request asks the shell for a current access
 * token and is sent through the shell (`fetch.tauri.ts`), since Epicenter's API
 * answers no `tauri://` page.
 */
import type {
	Account,
	AuthClient,
	AuthFetch,
	AuthState,
} from '@epicenter/auth';
import { AccountUnavailable, AuthError } from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { asPrincipalId } from '@epicenter/principal';
import { invoke } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import { shellFetch } from './fetch.tauri.js';
import type { PlatformAuth } from './types.js';

/** What the shell says about the account (`AccountState` in `account.rs`). */
type ShellState =
	| { status: 'signed-out'; baseUrl: string }
	| {
			status: 'signed-in' | 'reauth-required';
			baseUrl: string;
			principalId: string;
			generation: string;
			name: string | null;
			email: string | null;
	  };

/** The shell's account commands, injectable for tests. */
export type AccountShell = {
	state(): Promise<ShellState>;
	signIn(): Promise<ShellState>;
	signOut(): Promise<ShellState>;
	/** Rejects with a message starting `signed-out` or `reauth-required` when that is why. */
	token(): Promise<string>;
	send: AuthFetch;
};

const tauriShell: AccountShell = {
	state: () => invoke<ShellState>('account_state'),
	signIn: () => invoke<ShellState>('account_sign_in'),
	signOut: () => invoke<ShellState>('account_sign_out'),
	token: () => invoke<string>('account_token'),
	send: shellFetch,
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * An auth client over the desktop shell's account. Accounts are retired
 * (their signal aborts) on sign-out and when another sign-in replaces them.
 */
export function createShellAuth(
	shell: AccountShell,
	{ baseURL: initialBaseURL }: { baseURL: string },
): AuthClient {
	let state: AuthState = { status: 'signed-out' };
	/** The server the shell signs in to, as it last said. */
	let baseURL = initialBaseURL;
	let current: { generation: string; lifetime: AbortController } | undefined;
	const listeners = new Set<(state: AuthState) => void>();

	function accountFor(
		shellState: Exclude<ShellState, { status: 'signed-out' }>,
	) {
		const lifetime = new AbortController();
		const fetch: AuthFetch = async (input, init) => {
			lifetime.signal.throwIfAborted();
			const target = new URL(
				input instanceof Request ? input.url : String(input),
				shellState.baseUrl,
			);
			if (target.origin !== new URL(shellState.baseUrl).origin)
				throw new TypeError(
					'Account requests must target the server they signed in to.',
				);
			let token: string;
			try {
				token = await shell.token();
			} catch (cause) {
				const message = describe(cause);
				if (
					message.startsWith('reauth-required') ||
					message.startsWith('signed-out')
				) {
					void reconcile();
					throw AccountUnavailable({ code: 'reauth-required' }).error;
				}
				throw new TypeError(message);
			}
			lifetime.signal.throwIfAborted();
			const headers = new Headers(
				input instanceof Request ? input.headers : undefined,
			);
			new Headers(init?.headers).forEach((value, key) => {
				headers.set(key, value);
			});
			headers.set('authorization', `Bearer ${token}`);
			return shell.send(input instanceof Request ? input : target.href, {
				...init,
				headers,
				signal: init?.signal
					? AbortSignal.any([lifetime.signal, init.signal])
					: lifetime.signal,
			});
		};
		const account: Account = Object.freeze({
			authorityId: 'epicenter-api',
			principalId: asPrincipalId(shellState.principalId),
			baseURL: shellState.baseUrl,
			signal: lifetime.signal,
			fetch,
			getProfile: async () =>
				Ok({
					id: asPrincipalId(shellState.principalId),
					...(shellState.email !== null && { email: shellState.email }),
				}),
		});
		return { account, lifetime };
	}

	function publish(shellState: ShellState) {
		baseURL = shellState.baseUrl;
		let next: AuthState;
		if (shellState.status === 'signed-out') {
			current?.lifetime.abort(
				AccountUnavailable({ code: 'reauth-required' }).error,
			);
			current = undefined;
			next = { status: 'signed-out' };
		} else {
			if (current?.generation !== shellState.generation) {
				current?.lifetime.abort(
					AccountUnavailable({ code: 'reauth-required' }).error,
				);
				const { account, lifetime } = accountFor(shellState);
				current = { generation: shellState.generation, lifetime };
				next = { status: shellState.status, account };
			} else {
				next = {
					status: shellState.status,
					account: (state as Extract<AuthState, { account: Account }>).account,
				};
			}
		}
		if (next.status === state.status && next.account === state.account) return;
		state = next;
		for (const listener of listeners) listener(state);
	}

	async function reconcile() {
		publish(await shell.state());
	}

	return {
		getState: () => state,
		refresh: reconcile,
		get baseURL() {
			return baseURL;
		},
		onStateChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async startSignIn() {
			try {
				publish(await shell.signIn());
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				publish(await shell.signOut());
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		async getProfile() {
			if (state.status === 'signed-out')
				return AuthError.ProfileUnavailable({ cause: 'Not signed in.' });
			return state.account.getProfile();
		},
		[Symbol.dispose]() {
			current?.lifetime.abort();
			listeners.clear();
		},
	};
}

let auth: PlatformAuth | undefined;

/** This window's sign-in, made on first use and read from the shell then. */
export function getAuth(): PlatformAuth {
	if (auth) return auth;
	// The shell names the server it signs in to; until it answers, Epicenter's.
	const client = createShellAuth(tauriShell, {
		baseURL: 'https://api.epicenter.so',
	});
	void client.refresh().catch(() => {});
	auth = fromAuth(client);
	return auth;
}
