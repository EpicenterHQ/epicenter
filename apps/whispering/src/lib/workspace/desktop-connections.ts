/**
 * Whispering's two connections inside Epicenter (ADR-0557).
 *
 * Each is a row of the `connections` table in Epicenter's own folder,
 * `so.epicenter`: `whispering-transcription` and `whispering-text`, holding
 * the kind, a title, and the model, so they follow the person to every
 * computer where that folder syncs. Opening Whispering's window permits it
 * into that folder, which it reads through `connectionsDefinition`.
 *
 * The endpoint and key are not in the row. They live in this computer's
 * keychain under the row's id, and only the `epicenter` CLI reads them: the
 * page saves them with `ai_key_set`, learns the endpoint and whether a key
 * is saved with `ai_key_state`, and never reads a key back. A request goes
 * out through `ai_send`: the CLI checks that the keychain still holds the
 * endpoint the request was prepared for, adds the key, sends it, and streams
 * the response back, which `@epicenter/ai/send` reads into a `Response`. The
 * endpoint needs no CORS headers, because the request never leaves from the
 * page.
 *
 * A row of kind `epicenter` sends to the deployment the app signed in to,
 * `<origin>/v1`, with an `ai` access token the CLI mints from the app's
 * sign-in (`--desktop`), which Settings makes: the page learns the origin
 * and whether the app is signed in from `auth_status`, sends through the
 * same `ai_send` with an `epicenter` target, and holds no token. Whispering
 * cannot change such a row; Settings does. A `local` row is not used.
 *
 * The rules are `connections.ts`'s: a canonical base URL, a model, and a key
 * kept only for the base URL it was saved for.
 */

import {
	CONNECTIONS_FOLDER_ID,
	type connectionsDefinition,
} from '@epicenter/ai/connection-table';
import { sendThroughShell, toSendRequest } from '@epicenter/ai/send';
import type { Folder, FolderDefinition } from '@epicenter/folder';
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
import type { commands } from '../tauri/bindings.gen.js';

/** The rows Whispering uses, by operation: their stems in `so.epicenter/connections`. */
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

/** Why Whispering does not change an `epicenter` row. */
const SET_IN_SETTINGS =
	'This connection uses your Epicenter account. Change it in Epicenter’s Settings.';

/** The shell commands the connections use. */
export type ConnectionCommands = Pick<
	typeof commands,
	'aiKeyState' | 'aiKeySet' | 'aiSend' | 'authStatus'
>;

/** How a connection sends: over its own endpoint and key, or with the app's sign-in. */
type ConnectionTarget = 'openai-compatible' | 'epicenter';

/** A connection as a row and the shell describe it. */
type Resolved = {
	readonly target: ConnectionTarget;
	readonly connection: StoredConnection;
};

/** `so.epicenter` as Whispering opens it: through its `connections` table alone. */
export type ConnectionsFolder = Pick<
	Folder<typeof connectionsDefinition, FolderDefinition>,
	'tables' | 'close'
>;

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

/**
 * Whispering's connections in `so.epicenter`, opened when first read and
 * kept open until `close`.
 */
export function createDesktopConnections({
	commands: native,
	openConnections,
}: {
	commands: ConnectionCommands;
	/** Open `so.epicenter` through `connectionsDefinition`; injected for tests. */
	openConnections: () => Promise<
		Result<ConnectionsFolder, { readonly message: string }>
	>;
}) {
	let opening: Promise<ConnectionsFolder> | undefined;
	function folder() {
		opening ??= openConnections().then(({ data, error }) => {
			if (error !== null) {
				opening = undefined;
				throw new Error(
					`Epicenter's folder, ${CONNECTIONS_FOLDER_ID}, did not open: ${error.message}`,
				);
			}
			return data;
		});
		return opening;
	}

	/**
	 * The connection `operation` uses now, or undefined when its row is
	 * missing, is `local`, or names an endpoint this computer has no entry
	 * for. An `epicenter` row's endpoint is the signed-in deployment's `/v1`,
	 * and its key is present while the app is signed in.
	 */
	async function stored(operation: Operation): Promise<Resolved | undefined> {
		const id = CONNECTION_IDS[operation];
		const { data: row, error } = await (await folder()).tables.connections.get(
			id,
		);
		if (error !== null) throw new Error(error.message);
		if (row === undefined) return undefined;
		const { kind, model } = row.row.fields;
		if (kind === 'epicenter') {
			const { data: status, error: statusError } = await native.authStatus();
			if (statusError !== null) throw new Error(failureOf(statusError));
			const signedIn = status.grants.some(
				(grant) => grant.grant === 'desktop' && grant.signedIn,
			);
			return {
				target: 'epicenter',
				connection: {
					baseUrl: `${new URL(status.origin).origin}/v1`,
					model,
					...(signedIn && { apiKey: HELD_KEY }),
				},
			};
		}
		if (kind !== 'openai-compatible') return undefined;
		const { data: state, error: stateError } = await native.aiKeyState(id);
		if (stateError !== null) throw new Error(failureOf(stateError));
		if (state.state === 'missing') return undefined;
		return {
			target: 'openai-compatible',
			connection: {
				baseUrl: state.endpoint,
				model,
				...(state.hasKey && { apiKey: HELD_KEY }),
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
		return {
			transcription: infoOf(await stored('transcription')),
			text: infoOf(await stored('text')),
		};
	}

	return {
		read,

		/**
		 * Save one connection: its endpoint and key in the keychain first, then
		 * its row, made or updated in place.
		 */
		async set(
			operation: Operation,
			change: ConnectionChange,
		): Promise<Result<ConnectionsInfo, string>> {
			try {
				const id = CONNECTION_IDS[operation];
				const found = await stored(operation);
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
				if (!keepsEntry) {
					const { error } = await native.aiKeySet(
						id,
						next.baseUrl,
						change.key.action === 'replace' ? (next.apiKey ?? '') : '',
					);
					if (error !== null) return Err(failureOf(error));
				}
				const table = (await folder()).tables.connections;
				const { data: row, error: readError } = await table.get(id);
				if (readError !== null) return Err(readError.message);
				const { error: writeError } =
					row === undefined
						? await table.create(
								{
									fields: {
										kind: 'openai-compatible',
										title: TITLES[operation],
										model: next.model,
									},
									body: '',
								},
								{ stem: id },
							)
						: await table.set(id, {
								kind: 'openai-compatible',
								model: next.model,
							});
				if (writeError !== null) return Err(writeError.message);
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
			const found = await stored(operation);
			if (found === undefined) return undefined;
			const id = CONNECTION_IDS[operation];
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
						id,
						baseUrl,
						url,
						init,
					);
				},
			};
		},

		/** Close `so.epicenter`, if it was opened. */
		async close() {
			const opened = opening;
			opening = undefined;
			await opened?.then(
				(folder) => folder.close(),
				() => {},
			);
		},
	};
}
