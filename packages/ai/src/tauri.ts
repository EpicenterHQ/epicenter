/**
 * `@epicenter/ai/tauri`: the person's provider keys in a standalone desktop
 * app, and the requests sent with them. The keys belong to the custom
 * endpoints they unlock, so they live here and not with the account.
 *
 * - `keychain`: the shell's credential store, where each key is saved under
 *   a name of the page's own (`keychain_get`, `keychain_set` in
 *   `epicenter-account`). The page writes a key and never reads one back to
 *   send it.
 * - `connectionFetch(id)`: the `fetch` of one connected endpoint. The shell
 *   (`connection_fetch`) reads the key saved under `id`, adds it, and sends
 *   only to the endpoint it was saved for, so the page never holds the key
 *   and no endpoint needs to allow the window's origin (CORS). A connection
 *   with no saved key is sent with none.
 * - `shellFetch`: the same fetch with no connection and so no key, for a
 *   server on this computer (Ollama, LM Studio), which answers no
 *   `tauri://` page.
 */

import {
	messageOf,
	relayThroughShell,
	type ShellRelay,
	type TauriShell,
	tauriShell,
} from '@epicenter/account/tauri';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

/** A Fetch API function, as an endpoint sends with it. */
type Send = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Why the shell did not send a connection's request, or why its answer
 * ended early (`ConnectionFetchError` in `connection.rs`).
 */
export const ConnectionFetchError = defineErrors({
	/** The request does not read, or carried a credential of the page's. */
	InvalidRequest: ({ message }: { message: string }) => ({ message }),
	/** Neither `https`, nor `http` to `localhost` or `127.0.0.1`. */
	SchemeRefused: ({ message }: { message: string }) => ({ message }),
	/** Not on the origin of the endpoint the connection's key was saved for. */
	OriginRefused: ({ message }: { message: string }) => ({ message }),
	/** The keychain could not be read. */
	KeychainFailed: ({ message }: { message: string }) => ({ message }),
	/** The endpoint could not be reached, or its answer broke off. */
	SendFailed: ({ message }: { message: string }) => ({ message }),
});
export type ConnectionFetchError = InferErrors<typeof ConnectionFetchError>;

/** The shell's `ConnectionFetchError` as this page's, or a `TypeError` for anything else. */
function connectionFailure(cause: unknown) {
	const name =
		cause && typeof cause === 'object' && 'name' in cause
			? String(cause.name)
			: '';
	if (Object.hasOwn(ConnectionFetchError, name))
		return ConnectionFetchError[name as ConnectionFetchError['name']]({
			message: messageOf(cause),
		}).error;
	return new TypeError(messageOf(cause));
}

/**
 * The `fetch` of one connected endpoint (`connection` is its id): each
 * request goes to the shell, which reads the key the keychain keeps for the
 * connection, sends the request only to the endpoint that key was saved for
 * and with the key, and streams the answer back. The page sends no
 * credential, and no endpoint needs to allow this window's origin (CORS). A
 * refusal rejects with a {@link ConnectionFetchError}, as `fetch` rejects.
 * With `null` the shell sends with no key, as {@link shellFetch} does.
 */
export function connectionFetch(
	connection: string | null,
	shell: TauriShell = tauriShell,
): Send {
	const relay: ShellRelay = {
		fetch: 'connection_fetch',
		cancel: 'connection_fetch_cancel',
		fields: { connection },
		failure: connectionFailure,
	};
	return (input, init) =>
		relayThroughShell(shell, relay, new Request(input, init));
}

/**
 * The shell's fetch with no key: `https` anywhere, or `http` to `localhost`
 * or `127.0.0.1`, streamed back like a connection's. How a desktop app
 * reaches a server on this computer, which answers no `tauri://` page.
 */
export const shellFetch: Send = (input, init) =>
	connectionFetch(null)(input, init);

/**
 * The keys a page saves in the keychain under names of its own (a
 * connection's id): letters, digits, `_` and `-`.
 */
export const keychain = {
	get: (names: string[], shell: TauriShell = tauriShell) =>
		shell.invoke<Record<string, string>>('keychain_get', { names }),
	set: (name: string, value: string | null, shell: TauriShell = tauriShell) =>
		shell.invoke<void>('keychain_set', { name, value }),
};
