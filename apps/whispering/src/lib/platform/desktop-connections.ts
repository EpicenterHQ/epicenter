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
 * the `epicenter` CLI, which opens the selected directory for that one call. A save
 * carries the row's exact source as the page read it, so an edit Settings
 * made meanwhile is merged, not lost, and every field another program added
 * survives.
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

import { WHISPERING_CONNECTION_IDS } from '@epicenter/ai/connection-table';
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
import type { ConnectionRow, commands } from '../tauri/bindings.gen.js';

/** The rows Whispering uses, by operation: their stems in the selected records folder’s `connections/` directory. */
export const CONNECTION_IDS: Record<Operation, string> =
	WHISPERING_CONNECTION_IDS;

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
	| 'aiKeyState'
	| 'aiKeySet'
	| 'aiSend'
	| 'authStatus'
	| 'whisperingConnectionRead'
	| 'whisperingConnectionSet'
>;

/** How a connection sends: over its own endpoint and key, or with the app's sign-in. */
type ConnectionTarget = 'openai-compatible' | 'epicenter';

/** A connection as a row and the shell describe it. */
type Resolved = {
	readonly target: ConnectionTarget;
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

/** Whispering's connections in `so.epicenter`, read and saved through Epicenter. */
export function createDesktopConnections({
	commands: native,
}: {
	/** Epicenter's commands; injected for tests. */
	commands: ConnectionCommands;
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
			const { data: status, error: statusError } = await native.authStatus();
			if (statusError !== null) throw new Error(failureOf(statusError));
			const signedIn = status.grants.some(
				(grant) => grant.grant === 'desktop' && grant.signedIn,
			);
			return {
				row,
				found: {
					target: 'epicenter',
					connection: {
						baseUrl: `${new URL(status.origin).origin}/v1`,
						model,
						...(signedIn && { apiKey: HELD_KEY }),
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
				keyPresent: found.connection.apiKey !== undefined,
				readOnlyReason:
					found.target === 'epicenter' ? SET_IN_SETTINGS : undefined,
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
		 * its row, made or updated in place from the row as read. A save whose
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
				// A new row has a title; an existing one keeps its own, and every
				// field another program added. The save merges from the row as
				// read, so an edit that landed since stays.
				const { error: writeError } = await native.whisperingConnectionSet(
					operation,
					row && { text: row.text, issues: row.issues },
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
	};
}
