/**
 * Whispering's two connections inside Epicenter (ADR-0557).
 *
 * Each is a row of the `connections` table in Epicenter's selected records
 * folder: `whispering-transcription` and `whispering-text`, holding
 * the kind, a title, and the model, so they follow the person to every
 * computer where that folder syncs. The page opens no folder for them and is
 * permitted into none but its own. It names an operation, `transcription` or
 * `text`, and Epicenter reads the row (`whispering_connection_read`) or saves
 * the fields Whispering writes into it (`whispering_connection_set`) through
 * the `epicenter` CLI, which opens the selected directory for that one call. A save assigns fields to the current row; the last publication wins.
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
 * `<origin>/v1`, through an API-bound Account. Its desktop leaf reads the
 * grant through `auth_status`, captures the Account, and calls its `fetch`;
 * the host and CLI add the token outside the page. Whispering cannot change
 * such a row; Settings does. A `local` row is not used.
 *
 * The rules are `connections.ts`'s: a canonical base URL, a model, and a key
 * kept only for the base URL it was saved for.
 */

import { WHISPERING_CONNECTION_IDS } from '@epicenter/ai/connection-table';
import { sendThroughShell, toSendRequest } from '@epicenter/ai/send';
import type { Account } from '@epicenter/auth';
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
} from '../../connections.js';
import type { ConnectionRow, commands } from '../../tauri/bindings.gen.js';

/** The rows Whispering uses, by operation: their stems in the selected records folder’s `connections/` directory. */
export const CONNECTION_IDS: Record<Operation, string> =
	WHISPERING_CONNECTION_IDS;

const TITLES: Record<Operation, string> = {
	transcription: 'Whispering transcription',
	text: 'Whispering text',
};

/** Stands in for a user-supplied key the keychain holds while editing its connection. */
const HELD_KEY = 'held in the keychain';

/** Why Whispering does not change an `epicenter` row. */
const SET_IN_SETTINGS =
	'This connection uses your Epicenter account. Change it in Epicenter’s Settings.';
const SIGN_IN_FROM_SETTINGS =
	'Sign in from Epicenter’s Settings to use this connection.';

/** The shell commands the connections use. */
export type ConnectionCommands = Pick<
	typeof commands,
	| 'aiKeyState'
	| 'aiKeySet'
	| 'aiSend'
	| 'whisperingConnectionRead'
	| 'whisperingConnectionSet'
>;

/** A connection as a row and the shell describe it. */
type Resolved =
	| {
			readonly target: 'epicenter';
			readonly connection: StoredConnection;
			readonly account: Account | undefined;
			readonly problem: string | undefined;
	  }
	| {
			readonly target: 'openai-compatible';
			readonly connection: StoredConnection;
	  };

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const failureOf = (error: { name: string; message?: string }) =>
	error.message ?? `the shell refused the request (${error.name})`;

/** The row's file as a person finds it inside the selected Epicenter data folder. */
const rowPath = (operation: Operation) =>
	`connections/${CONNECTION_IDS[operation]}.md`;

/**
 * Send one fetch-shaped request over `connection` through `ai_send`, and
 * resolve with its response as it streams in. Rejects when nothing came
 * back, with the CLI's reason; a refusal means nothing was sent.
 */
async function sendThroughEpicenter(
	native: ConnectionCommands,
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
			{ kind: 'openai-compatible', connection, endpoint },
			wire,
			channel,
		);
		return refusal && { name: refusal.name, message: failureOf(refusal) };
	});
}

export type DesktopConnections = ReturnType<typeof createDesktopConnections>;

/** Whispering's connections in `so.epicenter`, read and saved through Epicenter. */
export function createDesktopConnections({
	commands: native,
	account,
}: {
	/** Epicenter's commands; injected for tests. */
	commands: ConnectionCommands;
	/** Capture the current API-bound Account before an operation sends. */
	account: () => Promise<{
		origin: string;
		account: Account | undefined;
		problem?: string;
	}>;
}) {
	/**
	 * The row `operation` names as Epicenter read it, or `null` when there
	 * is none, with the connection it describes now: undefined when the row
	 * is missing, is `local`, or names an endpoint this computer has no entry
	 * for. An `epicenter` row's endpoint is the signed-in deployment's `/v1`,
	 * and its key is present while the app is signed in. A row that does not
	 * read is never taken for none.
	 */
	async function stored(operation: Operation): Promise<{
		readonly row: ConnectionRow | null;
		readonly found: Resolved | undefined;
	}> {
		const id = CONNECTION_IDS[operation];
		const { data: row, error } =
			await native.whisperingConnectionRead(operation);
		if (error !== null) throw new Error(failureOf(error));
		if (row === null) return { row, found: undefined };
		if (row.fields === null)
			throw new Error(
				`${rowPath(operation)} does not read as a connection: ${(row.issues ?? []).map((issue) => issue.message).join('; ')}. Fix that file in Epicenter’s own folder to use it.`,
			);
		const { kind, model } = row.fields;
		if (kind === 'epicenter') {
			const current = await account();
			return {
				row,
				found: {
					target: 'epicenter',
					account: current.account,
					problem: current.problem,
					connection: {
						baseUrl: `${new URL(current.origin).origin}/v1`,
						model,
					},
				},
			};
		}
		if (kind !== 'openai-compatible') return { row, found: undefined };
		const { data: state, error: stateError } = await native.aiKeyState(id);
		if (stateError !== null) throw new Error(failureOf(stateError));
		if (state.state === 'missing') return { row, found: undefined };
		return {
			row,
			found: {
				target: 'openai-compatible',
				connection: {
					baseUrl: state.endpoint,
					model,
					...(state.hasKey && { apiKey: HELD_KEY }),
				},
			},
		};
	}

	function infoOf(found: Resolved | undefined): ConnectionInfo | undefined {
		return (
			found && {
				baseUrl: found.connection.baseUrl,
				model: found.connection.model,
				keyPresent:
					found.target === 'openai-compatible' &&
					found.connection.apiKey !== undefined,
				...(found.target === 'epicenter' && { source: 'account' as const }),
				readOnlyReason:
					found.target === 'epicenter'
						? (found.problem ??
							(found.account ? SET_IN_SETTINGS : SIGN_IN_FROM_SETTINGS))
						: undefined,
			}
		);
	}

	async function read(): Promise<ConnectionsInfo> {
		const [transcription, text] = await Promise.all([
			stored('transcription'),
			stored('text'),
		]);
		return {
			transcription: infoOf(transcription.found),
			text: infoOf(text.found),
		};
	}

	return {
		read,

		/**
		 * Save one connection: its endpoint and key in the keychain first, then
		 * its row, made or updated with the requested fields. A save whose
		 * reply never came back is reported as not confirmed, never as saved.
		 */
		async set(
			operation: Operation,
			change: ConnectionChange,
		): Promise<Result<ConnectionsInfo, string>> {
			try {
				const id = CONNECTION_IDS[operation];
				const { row, found } = await stored(operation);
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
				// A new row has a title; an existing one keeps its current title.
				const { error: writeError } = await native.whisperingConnectionSet(
					operation,
					row === null
						? {
								kind: 'openai-compatible',
								title: TITLES[operation],
								model: next.model,
							}
						: { kind: 'openai-compatible', model: next.model },
				);
				if (writeError?.name === 'Refused') return Err(writeError.message);
				if (writeError !== null)
					return Err(
						`Epicenter did not confirm that the ${OPERATION_NAMES[operation]} connection was saved, so it may or may not be: ${failureOf(writeError)}`,
					);
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
			const { found } = await stored(operation);
			if (found === undefined) return undefined;
			const account = found.target === 'epicenter' ? found.account : undefined;
			if (found.target === 'epicenter' && !account)
				throw new Error(found.problem ?? SIGN_IN_FROM_SETTINGS);
			const id = CONNECTION_IDS[operation];
			const { baseUrl, model } = found.connection;
			return {
				stored: { baseUrl, model },
				send(url, init) {
					if (!url.startsWith(`${baseUrl}/`))
						throw new Error(
							`${url} is not below the ${OPERATION_NAMES[operation]} connection's base URL.`,
						);
					if (account) {
						return account.fetch(url, init);
					}
					return sendThroughEpicenter(native, id, baseUrl, url, init);
				},
			};
		},
	};
}
