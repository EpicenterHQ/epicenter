/**
 * Sign-in with Epicenter in Vocab's desktop program (`#platform/auth`'s
 * desktop leaf), for hosted tutor models and dictation only: the desktop's
 * words and chats are files in its folder, which Epicenter syncs, so this
 * account never reaches a repository.
 *
 * The native shell holds the sign-in (`src-tauri/src/account.rs`): it signs
 * in through the system browser, keeps the refresh token in the keychain,
 * and sends each of the account's requests to Epicenter's API with a token
 * this page never sees. This module is an `AuthClient` over those commands,
 * so every component reads `auth` the same way in either build.
 */
import {
	type Account,
	AccountUnavailable,
	type AuthClient,
	AuthError,
	type AuthFetch,
	type AuthState,
	Principal,
} from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import type { VocabAuth } from './types.js';

/** What this module needs of the native shell; tests stand in for it. */
export type AccountShell = {
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	/** A channel that hands each message the shell sends to `onMessage`. */
	channel(onMessage: (message: unknown) => void): unknown;
};

const tauriShell: AccountShell = {
	invoke: (command, args) => invoke(command, args),
	channel: (onMessage) => new Channel<unknown>(onMessage),
};

/** `account_state`'s answer. */
type ShellState = {
	origin: string;
	signedIn: SignedIn | null;
	/** The server ended the sign-in; only signing in again helps. */
	refused: boolean;
};
type SignedIn = { origin: string; principalId: string };

/** What the shell sends on a request's channel besides the body's raw chunks. */
type RelayEvent =
	| { kind: 'head'; status: number; headers: [string, string][] }
	| { kind: 'end' }
	| {
			kind: 'error';
			message: string;
			refusal: 'reauth-required' | 'auth-unavailable' | null;
	  };

/** Statuses whose response has no body. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

function isChunk(
	message: unknown,
): message is ArrayBuffer | ArrayBufferView | number[] {
	return (
		message instanceof ArrayBuffer ||
		ArrayBuffer.isView(message) ||
		Array.isArray(message)
	);
}

function toBytes(chunk: ArrayBuffer | ArrayBufferView | number[]): Uint8Array {
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
	if (ArrayBuffer.isView(chunk))
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	return Uint8Array.from(chunk);
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let start = 0; start < bytes.length; start += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
	return btoa(binary);
}

/**
 * The account's `fetch`: each request goes to the shell, which sends it to
 * `origin` with the account's token and streams the answer back. A request
 * anywhere else is refused here, as the shell refuses it too. `lifetime`
 * aborts when the account is retired; `onRefusal` hears that the shell had
 * no token to send.
 */
export function relayFetch(
	shell: AccountShell,
	origin: string,
	lifetime: AbortSignal,
	onRefusal: (code: 'reauth-required' | 'auth-unavailable') => void,
): AuthFetch {
	let nextId = 0;
	return async (input, init) => {
		const target =
			input instanceof Request
				? input.url
				: new URL(String(input), `${origin}/`).href;
		const url = new URL(target);
		if (url.origin !== origin || url.username || url.password)
			throw new TypeError(
				`Account requests must go to ${origin}, not ${target}.`,
			);
		lifetime.throwIfAborted();
		const request = new Request(input instanceof Request ? input : url, init);
		const body =
			request.body === null
				? null
				: toBase64(new Uint8Array(await request.arrayBuffer()));
		const signal = AbortSignal.any([lifetime, request.signal]);
		signal.throwIfAborted();
		const id = ++nextId;
		const cancel = () =>
			void shell.invoke('account_fetch_cancel', { id }).catch(() => {});

		return new Promise<Response>((resolve, reject) => {
			let headed = false;
			let finished = false;
			let sink!: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					sink = controller;
				},
				cancel: () => {
					if (!finished) cancel();
				},
			});
			const fail = (error: unknown) => {
				if (finished) return;
				finished = true;
				signal.removeEventListener('abort', abort);
				if (!headed) reject(error);
				else sink.error(error);
			};
			const abort = () => {
				cancel();
				fail(signal.reason);
			};
			signal.addEventListener('abort', abort, { once: true });
			const channel = shell.channel((message) => {
				if (finished) return;
				if (isChunk(message)) {
					sink.enqueue(toBytes(message));
					return;
				}
				const event = message as RelayEvent;
				if (event.kind === 'head') {
					headed = true;
					const empty = NO_BODY.has(event.status);
					resolve(
						new Response(empty ? null : stream, {
							status: event.status,
							headers: event.headers,
						}),
					);
					return;
				}
				if (event.kind === 'end') {
					finished = true;
					signal.removeEventListener('abort', abort);
					sink.close();
					return;
				}
				if (event.refusal) {
					onRefusal(event.refusal);
					fail(AccountUnavailable({ code: event.refusal }).error);
					return;
				}
				fail(new TypeError(event.message));
			});
			shell
				.invoke('account_fetch', {
					request: {
						id,
						url: request.url,
						method: request.method,
						headers: [...request.headers],
						body,
					},
					onEvent: channel,
				})
				.catch(fail);
		});
	};
}

/** Who the account is, from userinfo through its own fetch. */
async function readProfile(fetch: AuthFetch, origin: string) {
	try {
		const response = await fetch(`${origin}/auth/oauth2/userinfo`);
		if (!response.ok)
			return AuthError.ProfileUnavailable({
				cause: `userinfo answered ${response.status}`,
			});
		const info = (await response.json()) as { sub?: unknown; email?: unknown };
		if (typeof info.sub !== 'string' || info.sub === '')
			return AuthError.ProfileUnavailable({ cause: 'userinfo named no one' });
		return Ok(
			Principal.assert(
				typeof info.email === 'string'
					? { id: info.sub, email: info.email }
					: { id: info.sub },
			),
		);
	} catch (cause) {
		return AuthError.ProfileUnavailable({ cause });
	}
}

/**
 * The desktop's `AuthClient` over the shell's account commands. `ready`
 * answers once the shell said who, if anyone, is signed in.
 */
export function createDesktopAuth(shell: AccountShell = tauriShell) {
	let state: AuthState = { status: 'signed-out' };
	let baseURL = '';
	let current: { account: Account; lifetime: AbortController } | undefined;
	const listeners = new Set<(state: AuthState) => void>();

	function publish(next: AuthState) {
		if (next.status === state.status && next.account === state.account) return;
		state = next;
		for (const listener of listeners) listener(state);
	}

	function retire() {
		current?.lifetime.abort(
			AccountUnavailable({ code: 'reauth-required' }).error,
		);
		current = undefined;
	}

	/** Publish `signedIn`, keeping the Account when it is the same person. */
	function adopt(signedIn: SignedIn, refused: boolean) {
		const principalId = Principal.assert({ id: signedIn.principalId }).id;
		let account = current?.account;
		if (
			account?.principalId !== principalId ||
			account.baseURL !== signedIn.origin
		) {
			retire();
			const lifetime = new AbortController();
			const fetch = relayFetch(
				shell,
				signedIn.origin,
				lifetime.signal,
				(code) => {
					if (code === 'reauth-required' && current?.account === opened)
						publish({ status: 'reauth-required', account: opened });
				},
			);
			const opened: Account = {
				authorityId: signedIn.origin,
				principalId,
				baseURL: signedIn.origin,
				signal: lifetime.signal,
				fetch,
				getProfile: () => readProfile(fetch, signedIn.origin),
			};
			current = { account: opened, lifetime };
			account = opened;
		}
		publish({ status: refused ? 'reauth-required' : 'signed-in', account });
	}

	async function refresh() {
		const answer = await shell.invoke<ShellState>('account_state');
		baseURL = answer.origin;
		if (answer.signedIn) adopt(answer.signedIn, answer.refused);
		else {
			retire();
			publish({ status: 'signed-out' });
		}
	}

	const client = {
		getState: () => state,
		refresh,
		get baseURL() {
			return baseURL;
		},
		onStateChange(listener: (state: AuthState) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async startSignIn() {
			try {
				adopt(await shell.invoke<SignedIn>('account_sign_in'), false);
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				await shell.invoke('account_sign_out');
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
			retire();
			publish({ status: 'signed-out' });
			return Ok(undefined);
		},
		async getProfile() {
			if (state.status === 'signed-out')
				return AuthError.ProfileUnavailable({ cause: 'signed out' });
			return state.account.getProfile();
		},
		[Symbol.dispose]() {
			listeners.clear();
		},
	} satisfies AuthClient;
	// Signed out until the shell answers; a shell that cannot is signed out.
	const ready = refresh().catch(() => {});
	return { client, ready };
}

const desktop = createDesktopAuth();

/** Answers once the shell said who is signed in; the desktop root waits for it. */
export const authReady = desktop.ready;

export const auth: VocabAuth = Object.assign(fromAuth(desktop.client), {
	purpose: {
		signedOut:
			'Your words and chats are files in this computer’s Vocab folder, with or without an account. Signing in adds Epicenter’s hosted tutor models and dictation.',
		signedIn:
			'Your words and chats stay in this computer’s Vocab folder; Sync with Epicenter to reach them elsewhere. This account provides hosted tutor models and dictation.',
	},
});
