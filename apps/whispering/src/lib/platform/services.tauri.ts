/**
 * Whispering's services in its desktop app: `#platform/services` under the
 * `tauri` condition.
 *
 * - Capture is the shell's microphone, which writes each recording into the
 *   folder from its first sample (`microphone.tauri.ts`).
 * - Connections and their keys are kept in this computer's credential store
 *   (Keychain on macOS) through the shell, one entry for both connections,
 *   never in Whispering's files and never in the WebView's storage.
 * - Transcription goes to one of three places: a custom OpenAI-compatible
 *   endpoint, the signed-in Epicenter account (the only use of signing in),
 *   or a local model on this computer (`@epicenter/transcription-native`),
 *   which transcribes the recording's file where it is.
 * - Every request leaves through the shell (`fetch.tauri.ts`), so an endpoint
 *   needs no CORS rule for the window's origin.
 */
import {
	AI_MODELS,
	HOSTED_TRANSCRIPTION_MODEL,
} from '@epicenter/constants/ai-providers';
import { commands as localModels } from '@epicenter/transcription-native';
import { invoke } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	applyConnectionChange,
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
import { getAuth } from './auth.tauri.js';
import { shellFetch } from './fetch.tauri.js';
import { createShellMicrophone } from './microphone.tauri.js';
import type { CreateServices } from './types.js';

/** The credential store entry holding both connections, keys included, as one JSON object. */
const CONNECTIONS = 'connections';

/** What a local transcription records as its endpoint. */
export const LOCAL_ENDPOINT = 'local';

/** Where the person sets up local models, named in refusals. */
const MODELS_HINT = 'Download a model under Settings, On this computer.';

/** The credential store, through the shell (`secret_get`, `secret_set`). */
export type SecretStore = {
	get(): Promise<string | null>;
	set(value: string): Promise<void>;
};

const shellSecrets: SecretStore = {
	get: () => invoke<string | null>('secret_get', { name: CONNECTIONS }),
	set: (value) => invoke<void>('secret_set', { name: CONNECTIONS, value }),
};

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
	'The Whispering connections in this computer’s credential store do not read as a JSON object, so they were left as they are. Remove the “connections” entry for Whispering there, then set them up again in Settings.';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** The installed local model chosen as active, or undefined. */
async function activeLocalModel(): Promise<string | undefined> {
	const models = await localModels.listInferenceModels();
	return models.find((model) => model.active && model.installed)?.id;
}

/**
 * Connections over `secrets`: the same rules as the browser's
 * (`connections.ts`), kept in the credential store, with a third route for
 * transcription on this computer.
 */
export function createDesktopConnections(secrets: SecretStore) {
	/** Every saved selection; throws when what is stored does not read. */
	async function stored(): Promise<Record<string, unknown>> {
		const text = await secrets.get();
		if (text === null) return {};
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
			if (
				record.kind === 'local' &&
				operation === 'transcription' &&
				customReads
			)
				return { kind: 'local', ...(custom && { custom }) };
		}
		const connection = readStoredConnection(value);
		if (connection === undefined)
			throw new Error(
				`The ${OPERATION_NAMES[operation]} connection in this computer’s credential store does not read as one. Set it up again in Settings.`,
			);
		return connection;
	}

	async function selection(operation: Operation) {
		return selectionIn(await stored(), operation);
	}

	const accountConnection = (model: string): StoredConnection => ({
		baseUrl: `${new URL(getAuth().baseURL).origin}/v1`,
		model,
	});

	async function info(
		operation: Operation,
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
		const state = getAuth().state;
		return {
			baseUrl: accountConnection(current.model).baseUrl,
			model: current.model,
			keyPresent: false,
			source: 'account',
			readOnlyReason:
				state.status === 'signed-in'
					? 'This connection uses your Epicenter account.'
					: 'Sign in to Epicenter to use this connection.',
		};
	}

	async function read(): Promise<ConnectionsInfo> {
		const all = await stored();
		return {
			transcription: await info(
				'transcription',
				selectionIn(all, 'transcription'),
			),
			text: await info('text', selectionIn(all, 'text')),
		};
	}

	/** The custom connection a selection keeps, to come back to. */
	const customOf = (current: Selection | undefined) =>
		current === undefined
			? undefined
			: 'kind' in current
				? current.custom
				: current;

	async function write(
		change: (all: Record<string, unknown>) => Record<string, unknown>,
	): Promise<Result<ConnectionsInfo, string>> {
		try {
			// One read and one write per change, so a key never sits beside a
			// base URL it was not saved for.
			const all = await stored();
			await secrets.set(JSON.stringify(change(all)));
			return Ok(await read());
		} catch (cause) {
			return Err(describe(cause));
		}
	}

	return {
		storedIn: 'this computer’s credential store',
		defaults: {
			transcription: DEFAULT_TRANSCRIPTION_CONNECTION,
			text: { baseUrl: DEFAULT_TRANSCRIPTION_CONNECTION.baseUrl, model: '' },
		},
		read,
		selection,
		accountConnection,
		async set(
			operation: Operation,
			change: Parameters<typeof applyConnectionChange>[2],
		) {
			let refusal: string | undefined;
			const written = await write((all) => {
				const current = selectionIn(all, operation);
				const { data: next, error } = applyConnectionChange(
					operation,
					current && 'kind' in current ? undefined : current,
					change,
				);
				if (error !== null) {
					refusal = error;
					return all;
				}
				return { ...all, [operation]: next };
			});
			return refusal === undefined ? written : Err(refusal);
		},
		useAccount: (operation: Operation) =>
			write((all) => {
				const custom = customOf(selectionIn(all, operation));
				return {
					...all,
					[operation]: {
						kind: 'epicenter',
						model:
							operation === 'transcription'
								? HOSTED_TRANSCRIPTION_MODEL
								: AI_MODELS[0].id,
						...(custom && { custom }),
					},
				};
			}),
		useLocal: (operation: Operation) =>
			operation !== 'transcription'
				? Promise.resolve(Err('Only transcription runs on this computer.'))
				: write((all) => {
						const custom = customOf(selectionIn(all, operation));
						return {
							...all,
							[operation]: { kind: 'local', ...(custom && { custom }) },
						};
					}),
		useCustom: (operation: Operation) =>
			write((all) => {
				const next = { ...all };
				const custom = customOf(selectionIn(all, operation));
				if (custom) next[operation] = custom;
				else delete next[operation];
				return next;
			}),
	};
}

/** Where a request of `operation` goes now, read once. */
async function routeOf(
	connections: ReturnType<typeof createDesktopConnections>,
	operation: Operation,
) {
	const current = await connections.selection(operation);
	if (current === undefined) return undefined;
	if (!('kind' in current))
		return { source: 'custom' as const, stored: current, send: shellFetch };
	if (current.kind === 'local') return { source: 'local' as const };
	const state = getAuth().state;
	if (state.status !== 'signed-in')
		throw new Error('Sign in to Epicenter in Settings before sending.');
	return {
		source: 'account' as const,
		stored: connections.accountConnection(current.model),
		send: (url: string, init?: RequestInit) => state.account.fetch(url, init),
	};
}

/** Transcribe the file at `path` in the window's folder with local model `model`. */
async function transcribeHere(path: string | undefined, model: string) {
	if (path === undefined)
		return TranscriptionError.AudioUnreadable({
			reason: 'this recording has no audio file in the folder',
		});
	if (model.trim() === '')
		return TranscriptionError.NotConfigured({
			missing: `a local model. ${MODELS_HINT}`,
		});
	try {
		const { data, error } = await localModels.transcribeFile(model, path, {
			language: null,
			initialPrompt: null,
		});
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

/** Whispering's services in its desktop app: `#platform/services`. */
export const createServices: CreateServices = () => {
	const connections = createDesktopConnections(shellSecrets);
	return {
		capture: createShellMicrophone(),
		async transcribe(request) {
			let route: Awaited<ReturnType<typeof routeOf>>;
			try {
				route = await routeOf(connections, 'transcription');
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
				return transcribeHere(request.audioPath, request.model);
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
					route = await routeOf(connections, 'text');
					return route?.source === 'local' ? undefined : route?.stored;
				},
				request,
				(url, init) =>
					(route as Extract<typeof route, { send: unknown }>).send(url, init),
			);
		},
		transformNote:
			'Requests leave from this computer through Whispering, so any endpoint works, including one on this computer or your network.',
		connections: {
			storedIn: connections.storedIn,
			defaults: connections.defaults,
			read: connections.read,
			set: connections.set,
			useAccount: connections.useAccount,
			useCustom: connections.useCustom,
			useLocal: connections.useLocal,
		},
		preferences: localPreferences,
	};
};
