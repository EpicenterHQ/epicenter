/**
 * Whispering's two connections inside Epicenter (ADR-0557, ADR-0587).
 *
 * A connection is this computer's: an entry the `epicenter` CLI keeps in
 * Epicenter's app data, holding the kind, a title, and the model, with an
 * `openai-compatible` connection's endpoint and key in this computer's
 * keychain under the same id. The page lists the connections with
 * `ai_key_list`, which names each endpoint and whether its key is saved but
 * never the key, and saves one with `ai_key_set`. It opens no folder for
 * them. A request goes out through `ai_send`: the CLI checks that the
 * keychain still holds the endpoint the request was prepared for, adds the
 * key, sends it, and streams the response back, which `@epicenter/ai/send`
 * reads into a `Response`. The endpoint needs no CORS headers, because the
 * request never leaves from the page.
 *
 * Which connection each operation uses is Whispering's choice on this
 * computer, kept by the CLI under Whispering's id and answered by
 * `ai_key_list` as `uses` (`epicenter auth key use`). With no choice
 * recorded, an operation uses its own connection, `whispering-transcription`
 * or `whispering-text`, which Whispering adds when it is first saved.
 *
 * A connection of kind `epicenter` sends to the deployment the app signed in
 * to, `<origin>/v1`, with an `ai` access token the CLI mints from the app's
 * sign-in (`--desktop`), which Settings makes: the page learns the origin
 * and whether the app is signed in from `auth_status`, sends through the
 * same `ai_send` with an `epicenter` target, and holds no token. Whispering
 * cannot change such a connection; Settings does. A `local` one is not used.
 *
 * The rules are `connections.ts`'s: a canonical base URL, a model, and a key
 * kept only for the base URL it was saved for.
 */

import { sendThroughShell, toSendRequest } from '@epicenter/ai/send';
import { Channel } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	applyConnectionChange,
	type ConnectionChange,
	type ConnectionInfo,
	type ConnectionsInfo,
	OPERATION_NAMES,
	type Operation,
	type StoredConnection,
} from '../connections.js';
import type { AiConnections, commands } from '../tauri/bindings.gen.js';

/**
 * The connection each operation uses while this computer records no other
 * choice for Whispering: its own, which it adds when first saved.
 */
export const CONNECTION_IDS: Record<Operation, string> = {
	transcription: 'whispering-transcription',
	text: 'whispering-text',
};

const TITLES: Record<Operation, string> = {
	transcription: 'Whispering transcription',
	text: 'Whispering text',
};

/** Stands in for a key the keychain holds, so `applyConnectionChange` can refuse carrying it elsewhere. */
const HELD_KEY = 'held in the keychain';

/** Why Whispering does not change an `epicenter` connection. */
const SET_IN_SETTINGS =
	'This connection uses your Epicenter account. Change it in Epicenter’s Settings.';

/** The shell commands the connections use. */
export type ConnectionCommands = Pick<
	typeof commands,
	'aiKeyList' | 'aiKeySet' | 'aiSend' | 'authStatus'
>;

/** How a connection sends: over its own endpoint and key, or with the app's sign-in. */
type ConnectionTarget = 'openai-compatible' | 'epicenter';

/** A connection as the listing and the shell describe it. */
type Resolved = {
	readonly id: string;
	readonly target: ConnectionTarget;
	readonly connection: StoredConnection;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const failureOf = (error: { name: string; message?: string }) =>
	error.message ?? `the shell refused the request (${error.name})`;

/**
 * Send one fetch-shaped request over `connection` through `ai_send`, and
 * resolve with its response as it streams in. Rejects when nothing came
 * back, with the CLI's reason; a refusal means nothing was sent.
 */
async function sendThroughEpicenter(
	native: ConnectionCommands,
	target: ConnectionTarget,
	connection: string,
	endpoint: string,
	input: string,
	init?: RequestInit,
): Promise<Response> {
	const { data: request, error } = await toSendRequest(endpoint, input, init);
	if (error !== null) throw new Error(error.message);
	return sendThroughShell(request, async (wire, onLine) => {
		const channel = new Channel<string>();
		channel.onmessage = onLine;
		const { error: refusal } = await native.aiSend(
			target === 'epicenter'
				? { kind: 'epicenter', connection }
				: { kind: 'openai-compatible', connection, endpoint },
			wire,
			channel,
		);
		return refusal && { name: refusal.name, message: failureOf(refusal) };
	});
}

export type DesktopConnections = ReturnType<typeof createDesktopConnections>;

/** Whispering's connections on this computer, listed afresh on every read. */
export function createDesktopConnections({
	commands: native,
}: {
	commands: ConnectionCommands;
}) {
	async function list(): Promise<AiConnections> {
		const { data, error } = await native.aiKeyList();
		if (error !== null) throw new Error(failureOf(error));
		return data;
	}

	/** The id of the connection `operation` uses: Whispering's choice, or its own. */
	const idFor = (listing: AiConnections, operation: Operation) =>
		listing.uses[operation] ?? CONNECTION_IDS[operation];

	/**
	 * The connection `operation` uses now, or undefined when it is not on
	 * this computer, is `local`, or has no endpoint saved here. An `epicenter`
	 * connection's endpoint is the signed-in deployment's `/v1`, and its key
	 * is present while the app is signed in.
	 */
	async function stored(
		listing: AiConnections,
		operation: Operation,
	): Promise<Resolved | undefined> {
		const id = idFor(listing, operation);
		const found = listing.connections.find(
			(connection) => connection.id === id,
		);
		if (found === undefined) return undefined;
		const { kind, model, key } = found;
		if (kind === 'epicenter') {
			const { data: status, error: statusError } = await native.authStatus();
			if (statusError !== null) throw new Error(failureOf(statusError));
			const signedIn = status.grants.some(
				(grant) => grant.grant === 'desktop' && grant.signedIn,
			);
			return {
				id,
				target: 'epicenter',
				connection: {
					baseUrl: `${new URL(status.origin).origin}/v1`,
					model,
					...(signedIn && { apiKey: HELD_KEY }),
				},
			};
		}
		if (kind !== 'openai-compatible') return undefined;
		if (key?.state === 'unreadable') throw new Error(key.message);
		if (key?.state !== 'saved') return undefined;
		return {
			id,
			target: 'openai-compatible',
			connection: {
				baseUrl: key.endpoint,
				model,
				...(key.hasKey && { apiKey: HELD_KEY }),
			},
		};
	}

	function infoOf(found: Resolved | undefined): ConnectionInfo | undefined {
		return (
			found && {
				baseUrl: found.connection.baseUrl,
				model: found.connection.model,
				keyPresent: found.connection.apiKey !== undefined,
				readOnlyReason:
					found.target === 'epicenter' ? SET_IN_SETTINGS : undefined,
			}
		);
	}

	async function read(): Promise<ConnectionsInfo> {
		const listing = await list();
		return {
			transcription: infoOf(await stored(listing, 'transcription')),
			text: infoOf(await stored(listing, 'text')),
		};
	}

	return {
		read,

		/**
		 * Save the connection `operation` uses, in one `ai_key_set`: its entry
		 * first, made with its kind and title when it is new, then, unless the
		 * saved key is kept, its endpoint and key.
		 */
		async set(
			operation: Operation,
			change: ConnectionChange,
		): Promise<Result<ConnectionsInfo, string>> {
			try {
				const listing = await list();
				const id = idFor(listing, operation);
				const found = await stored(listing, operation);
				if (found?.target === 'epicenter') return Err(SET_IN_SETTINGS);
				const current = found?.connection;
				const { data: next, error: changeError } = applyConnectionChange(
					operation,
					current,
					change,
				);
				if (changeError !== null) return Err(changeError);
				// A kept key stays where it is; anything else is saved again,
				// with no key when there is none.
				const keepsEntry =
					change.key.action === 'keep' &&
					current !== undefined &&
					current.baseUrl === next.baseUrl;
				const isNew = !listing.connections.some(
					(connection) => connection.id === id,
				);
				const { error } = await native.aiKeySet(id, {
					...(isNew && { kind: 'openai-compatible', title: TITLES[operation] }),
					model: next.model,
					...(!keepsEntry && {
						endpoint: next.baseUrl,
						key: change.key.action === 'replace' ? (next.apiKey ?? '') : '',
					}),
				});
				if (error !== null) return Err(failureOf(error));
				return Ok(await read());
			} catch (cause) {
				return Err(describe(cause));
			}
		},

		/**
		 * The stored connection a request is checked against, and the `fetch`
		 * that sends it through Epicenter to that same endpoint. The CLI refuses
		 * a request once the keychain names another endpoint, rather than
		 * retargeting it.
		 */
		async route(operation: Operation): Promise<
			| {
					readonly stored: StoredConnection;
					readonly send: (url: string, init?: RequestInit) => Promise<Response>;
			  }
			| undefined
		> {
			const found = await stored(await list(), operation);
			if (found === undefined) return undefined;
			const { baseUrl, model } = found.connection;
			return {
				stored: { baseUrl, model },
				send(url, init) {
					if (!url.startsWith(`${baseUrl}/`))
						throw new Error(
							`${url} is not below the ${OPERATION_NAMES[operation]} connection's base URL.`,
						);
					return sendThroughEpicenter(
						native,
						found.target,
						found.id,
						baseUrl,
						url,
						init,
					);
				},
			};
		},
	};
}
