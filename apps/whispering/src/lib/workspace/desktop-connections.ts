/**
 * Whispering's two connections inside Epicenter (ADR-0557).
 *
 * Each is a row of the `connections` table in Epicenter's own folder,
 * `so.epicenter`: `whispering-transcription` and `whispering-text`, holding
 * the kind, a title, and the model, so they follow the person to every
 * computer where that folder syncs. Opening Whispering's window permits it
 * into that folder, which it reads through `connectionsLens`.
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
 * The rules are `connections.ts`'s: a canonical base URL, a model, and a key
 * kept only for the base URL it was saved for.
 */

import {
	CONNECTIONS_FOLDER_ID,
	type connectionsLens,
} from '@epicenter/ai/connection-table';
import {
	bytesToBase64,
	createResponseReader,
	type SendEvent,
	toSendRequest,
} from '@epicenter/ai/send';
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

/** The shell commands the connections use. */
export type ConnectionCommands = Pick<
	typeof commands,
	'aiKeyState' | 'aiKeySet' | 'aiSend'
>;

/** `so.epicenter` as Whispering opens it: through its `connections` table alone. */
export type ConnectionsFolder = Pick<
	Folder<typeof connectionsLens, FolderDefinition>,
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
	connection: string,
	endpoint: string,
	input: string,
	init?: RequestInit,
): Promise<Response> {
	const { data: request, error } = await toSendRequest(endpoint, input, init);
	if (error !== null) throw new Error(error.message);
	const reader = createResponseReader();
	const channel = new Channel<string>();
	channel.onmessage = (line) => {
		let event: SendEvent | { type: 'exit'; code: number; stderr: string };
		try {
			event = JSON.parse(line);
		} catch {
			reader.fail({
				name: 'InvalidResponse',
				message: 'Epicenter answered with a line that does not read',
			});
			return;
		}
		// The shell's own last line: the run ended, so a response not ended by now never will be.
		if (event.type === 'exit')
			reader.fail({
				name: 'Incomplete',
				message: `the epicenter command exited ${event.code}${event.stderr.trim() ? `: ${event.stderr.trim()}` : ''}`,
			});
		else reader.push(event);
	};
	native
		.aiSend(
			{ kind: 'openai-compatible', connection, endpoint },
			{
				method: request.method,
				path: request.path,
				headers: request.headers.map(([name, value]) => [name, value]),
				body: request.body ? bytesToBase64(request.body) : null,
			},
			channel,
		)
		.then(
			({ error: runError }) => {
				if (runError !== null)
					reader.fail({ name: runError.name, message: failureOf(runError) });
			},
			(cause: unknown) =>
				reader.fail({ name: 'Failed', message: describe(cause) }),
		);
	const { data: response, error: failure } = await reader.response;
	if (failure !== null)
		throw Object.assign(new Error(failure.message), { name: failure.name });
	return response;
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
	/** Open `so.epicenter` through `connectionsLens`; injected for tests. */
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

	/** The row and keychain entry `operation` uses now, or undefined when either is missing. */
	async function stored(
		operation: Operation,
	): Promise<StoredConnection | undefined> {
		const id = CONNECTION_IDS[operation];
		const { data: row, error } = await (await folder()).tables.connections.get(
			id,
		);
		if (error !== null) throw new Error(error.message);
		if (row === undefined || row.row.fields.kind !== 'openai-compatible')
			return undefined;
		const { data: state, error: stateError } = await native.aiKeyState(id);
		if (stateError !== null) throw new Error(failureOf(stateError));
		if (state.state === 'missing') return undefined;
		return {
			baseUrl: state.endpoint,
			model: row.row.fields.model,
			...(state.hasKey && { apiKey: HELD_KEY }),
		};
	}

	function infoOf(
		connection: StoredConnection | undefined,
	): ConnectionInfo | undefined {
		return (
			connection && {
				baseUrl: connection.baseUrl,
				model: connection.model,
				keyPresent: connection.apiKey !== undefined,
				readOnlyReason: undefined,
			}
		);
	}

	async function read(): Promise<ConnectionsInfo> {
		return {
			transcription: infoOf(await stored('transcription')),
			text: infoOf(await stored('text')),
			legacyKey: false,
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
				const current = await stored(operation);
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
						: await table.update(id, {
								set: { kind: 'openai-compatible', model: next.model },
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
			return {
				stored: { baseUrl: found.baseUrl, model: found.model },
				send(url, init) {
					if (!url.startsWith(`${found.baseUrl}/`))
						throw new Error(
							`${url} is not below the ${OPERATION_NAMES[operation]} connection's base URL.`,
						);
					return sendThroughEpicenter(native, id, found.baseUrl, url, init);
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
