/**
 * Whispering's services in its desktop app: `#platform/services` under the
 * `tauri` condition, over the data folder the window opened.
 *
 * - Capture is the shell's microphone, which writes each recording into the
 *   data folder from its first sample (`microphone.tauri.ts`).
 * - Connections and their keys are kept in this computer's keychain through
 *   the shell (`keychain` from `@epicenter/auth/tauri`), one entry for both
 *   connections, never in Whispering's files and never in the WebView's
 *   storage.
 * - Transcription goes to one of three places: a custom OpenAI-compatible
 *   endpoint, the signed-in Epicenter account (the only use of signing in),
 *   or a local model on this computer (`@epicenter/transcription-native`),
 *   which transcribes the recording's file where it is.
 * - A custom endpoint's request leaves through the shell (`fetch.tauri.ts`),
 *   so it needs no CORS rule for the window's origin. The account's request
 *   goes through the account's own relay (`account_fetch`), which adds the
 *   token the page never holds.
 */

import { keychain } from '@epicenter/auth/tauri';
import {
	AI_MODELS,
	HOSTED_TRANSCRIPTION_MODEL,
} from '@epicenter/constants/ai-providers';
import { rootOf } from '@epicenter/folder/tauri';
import { commands as localModels } from '@epicenter/transcription-native';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	applyConnectionChange,
	type ConnectionChange,
	type ConnectionInfo,
	type ConnectionsInfo,
	connectionInfo,
	DEFAULT_TRANSCRIPTION_CONNECTION,
	OPERATION_NAMES,
	type Operation,
	readStoredConnection,
	type StoredConnection,
} from '../connections.js';
import { localPreferences } from '../microphone-preference.js';
import {
	TranscriptionError,
	transcribeOverConnection,
} from '../transcription.js';
import { transformOverConnection } from '../transformation.js';
import { authReady, getAuth } from './auth.tauri.js';
import { shellFetch } from './fetch.tauri.js';
import { createShellMicrophone } from './microphone.tauri.js';
import type { CreateServices } from './types.js';

/** The keychain entry holding both connections, keys included, as one JSON object. */
const CONNECTIONS = 'connections';

/** What a local transcription records as its endpoint. */
export const LOCAL_ENDPOINT = 'local';

/** Where the person sets up local models, named in refusals. */
const MODELS_HINT = 'Download a model under Settings, On this computer.';

type AccountSelection = {
	readonly kind: 'epicenter';
	readonly model: string;
	readonly custom?: StoredConnection;
};
type LocalSelection = {
	readonly kind: 'local';
	readonly custom?: StoredConnection;
};
type Selection = StoredConnection | AccountSelection | LocalSelection;

const UNREADABLE =
	'The Whispering connections in this computer’s credential store do not read as a JSON object, so they were left as they are. Remove Whispering’s “key:connections” entry there, then set them up again in Settings.';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** Every saved selection; throws when what is stored does not read. */
async function stored(): Promise<Record<string, unknown>> {
	const text = (await keychain.get([CONNECTIONS]))[CONNECTIONS];
	if (text === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(UNREADABLE);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new Error(UNREADABLE);
	return parsed as Record<string, unknown>;
}

function selectionIn(
	all: Record<string, unknown>,
	operation: Operation,
): Selection | undefined {
	const value = all[operation];
	if (value === undefined) return undefined;
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const custom =
			record.custom === undefined
				? undefined
				: readStoredConnection(record.custom);
		const customReads = record.custom === undefined || custom !== undefined;
		if (
			record.kind === 'epicenter' &&
			typeof record.model === 'string' &&
			record.model.trim() !== '' &&
			customReads
		)
			return {
				kind: 'epicenter',
				model: record.model,
				...(custom && { custom }),
			};
		if (record.kind === 'local' && operation === 'transcription' && customReads)
			return { kind: 'local', ...(custom && { custom }) };
	}
	const connection = readStoredConnection(value);
	if (connection === undefined)
		throw new Error(
			`The ${OPERATION_NAMES[operation]} connection in this computer’s credential store does not read as one. Set it up again in Settings.`,
		);
	return connection;
}

/** The custom connection a selection keeps, to come back to. */
function customOf(current: Selection | undefined) {
	if (current === undefined) return undefined;
	return 'kind' in current ? current.custom : current;
}

/** The account's endpoint for `model`, once the shell said which deployment it signs in to. */
async function accountConnection(model: string): Promise<StoredConnection> {
	await authReady();
	return { baseUrl: `${new URL(getAuth().baseURL).origin}/v1`, model };
}

/** The installed local model chosen as active, or undefined. */
async function activeLocalModel(): Promise<string | undefined> {
	const models = await localModels.listInferenceModels();
	return models.find((model) => model.active && model.installed)?.id;
}

async function info(
	current: Selection | undefined,
): Promise<ConnectionInfo | undefined> {
	if (current === undefined) return undefined;
	if (!('kind' in current)) return connectionInfo(current);
	if (current.kind === 'local') {
		const model = await activeLocalModel().catch(() => undefined);
		return {
			baseUrl: LOCAL_ENDPOINT,
			model: model ?? '',
			keyPresent: false,
			source: 'local',
			readOnlyReason:
				model === undefined
					? `Transcribes on this computer once a model is chosen. ${MODELS_HINT}`
					: 'Transcribes on this computer. Nothing leaves it.',
		};
	}
	const connection = await accountConnection(current.model);
	return {
		baseUrl: connection.baseUrl,
		model: current.model,
		keyPresent: false,
		source: 'account',
		readOnlyReason:
			getAuth().state.status === 'signed-in'
				? 'This connection uses your Epicenter account.'
				: 'Sign in to Epicenter to use this connection.',
	};
}

async function read(): Promise<ConnectionsInfo> {
	const all = await stored();
	return {
		transcription: await info(selectionIn(all, 'transcription')),
		text: await info(selectionIn(all, 'text')),
	};
}

/** Rewrite the saved selections with `change`, in one read and one write. */
async function write(
	change: (
		all: Record<string, unknown>,
	) => Result<Record<string, unknown>, string>,
): Promise<Result<ConnectionsInfo, string>> {
	try {
		// One read and one write per change, so a key never sits beside a
		// base URL it was not saved for.
		const { data: next, error } = change(await stored());
		if (error !== null) return Err(error);
		await keychain.set(CONNECTIONS, JSON.stringify(next));
		return Ok(await read());
	} catch (cause) {
		return Err(describe(cause));
	}
}

/** Where a request of `operation` goes now, read once. Throws when it cannot be read or used. */
async function routeOf(operation: Operation) {
	const current = selectionIn(await stored(), operation);
	if (current === undefined) return undefined;
	if (!('kind' in current))
		return { source: 'custom' as const, stored: current, send: shellFetch };
	if (current.kind === 'local') return { source: 'local' as const };
	const connection = await accountConnection(current.model);
	const state = getAuth().state;
	if (state.status !== 'signed-in')
		throw new Error('Sign in to Epicenter in Settings before sending.');
	return {
		source: 'account' as const,
		stored: connection,
		send: (url: string, init?: RequestInit) => state.account.fetch(url, init),
	};
}

/** Transcribe the file at `path` in the data folder `root` with local model `model`. */
async function transcribeHere(
	root: string,
	path: string | undefined,
	model: string,
): Promise<Result<{ text: string }, TranscriptionError>> {
	if (path === undefined)
		return TranscriptionError.AudioUnreadable({
			reason: 'this recording has no audio file in the folder',
		});
	if (model.trim() === '')
		return TranscriptionError.NotConfigured({
			missing: `a local model. ${MODELS_HINT}`,
		});
	try {
		const { data, error } = await localModels.transcribeFile(
			model,
			root,
			path,
			{
				language: null,
				initialPrompt: null,
			},
		);
		if (error !== null) {
			if (error.name === 'FileMissing' || error.name === 'AudioReadError')
				return TranscriptionError.AudioUnreadable({ reason: error.message });
			if (error.name === 'LocalRouteUnavailable')
				return TranscriptionError.ConnectionUnavailable({
					reason: `${error.message} ${MODELS_HINT}`,
				});
			return TranscriptionError.LocalFailed({ reason: error.message });
		}
		if (data.outcome === 'empty-audio')
			return TranscriptionError.AudioUnreadable({
				reason: 'the recording holds no audio',
			});
		return Ok({ text: data.text.trim() });
	} catch (cause) {
		return TranscriptionError.LocalFailed({ reason: describe(cause) });
	}
}

/** Whispering's services in its desktop app, over the data folder `client` opened. */
export const createServices: CreateServices = (client) => {
	// The data folder is always opened by its path (`openDataFolder`); with
	// no root the shell would record into the window's own folder, AppData.
	const root = rootOf(client);
	if (root === undefined)
		throw new Error(
			'Whispering’s desktop services need the data folder, opened by its path.',
		);
	return {
		capture: createShellMicrophone(root),
		async transcribe(request) {
			let route: Awaited<ReturnType<typeof routeOf>>;
			try {
				route = await routeOf('transcription');
			} catch (cause) {
				return TranscriptionError.ConnectionUnavailable({
					reason: describe(cause),
				});
			}
			if (route?.source === 'local') {
				// A request prepared for another connection is never retargeted.
				if (request.expectedBaseUrl !== LOCAL_ENDPOINT)
					return TranscriptionError.ConnectionChanged({
						expected: request.expectedBaseUrl,
						configured: LOCAL_ENDPOINT,
					});
				return transcribeHere(root, request.audioPath, request.model);
			}
			const selected = route;
			return transcribeOverConnection(
				async () => selected?.stored,
				request,
				(url, init) => selected!.send(url, init),
			);
		},
		async transform(request) {
			let route: Awaited<ReturnType<typeof routeOf>>;
			return transformOverConnection(
				async () => {
					route = await routeOf('text');
					return route?.source === 'local' ? undefined : route?.stored;
				},
				request,
				(url, init) =>
					(route as Extract<typeof route, { send: unknown }>).send(url, init),
			);
		},
		transformNote:
			'Custom endpoint requests leave from this computer through Whispering, so any endpoint works, including one on this computer or your network. The Epicenter account route uses Epicenter’s API.',
		connections: {
			storedIn: 'this computer’s credential store',
			defaults: {
				transcription: DEFAULT_TRANSCRIPTION_CONNECTION,
				text: { baseUrl: DEFAULT_TRANSCRIPTION_CONNECTION.baseUrl, model: '' },
			},
			read,
			set: (operation: Operation, change: ConnectionChange) =>
				write((all) => {
					const current = selectionIn(all, operation);
					const { data: next, error } = applyConnectionChange(
						operation,
						current && 'kind' in current ? undefined : current,
						change,
					);
					if (error !== null) return Err(error);
					return Ok({ ...all, [operation]: next });
				}),
			useAccount: (operation) =>
				write((all) => {
					const custom = customOf(selectionIn(all, operation));
					return Ok({
						...all,
						[operation]: {
							kind: 'epicenter',
							model:
								operation === 'transcription'
									? HOSTED_TRANSCRIPTION_MODEL
									: AI_MODELS[0].id,
							...(custom && { custom }),
						},
					});
				}),
			useLocal: (operation) =>
				write((all) => {
					if (operation !== 'transcription')
						return Err('Only transcription runs on this computer.');
					const custom = customOf(selectionIn(all, operation));
					return Ok({
						...all,
						[operation]: { kind: 'local', ...(custom && { custom }) },
					});
				}),
			useCustom: (operation) =>
				write((all) => {
					const next = { ...all };
					const custom = customOf(selectionIn(all, operation));
					if (custom) next[operation] = custom;
					else delete next[operation];
					return Ok(next);
				}),
		},
		preferences: localPreferences,
	};
};
