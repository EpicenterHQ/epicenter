/** Browser capture, requests and device preferences over the folder the app opened. */

import {
	AI_MODELS,
	HOSTED_TRANSCRIPTION_MODEL,
} from '@epicenter/constants/ai-providers';
import { Err, Ok } from 'wellcrafted/result';
import { audioMimeTypeOf } from '../audio-format.js';
import { createFixtureDevice, toneWav } from '../capture.js';
import {
	applyConnectionChange,
	type ConnectionsInfo,
	connectionInfo,
	OPERATION_NAMES,
	type Operation,
	readStoredConnection,
	type StoredConnection,
} from '../connections.js';
import { DEFAULT_TRANSCRIPTION_CONNECTION } from '../definition.js';
import { readBytes } from '../files.js';
import { localPreferences } from '../microphone-preference.js';
import { transcribeOverConnection } from '../transcription.js';
import {
	TransformationError,
	transformOverConnection,
} from '../transformation.js';
import { createWebViewMicrophone } from '../webview-microphone.js';
import { getAuth } from './auth.js';
import type { CreateServices } from './types.js';

/** This tab's two connections, keys included, as one JSON object. */
const CONNECTIONS_STORAGE = 'whispering.connections';

const UNREADABLE_CONNECTIONS =
	'This browser’s saved Whispering connections do not read as a JSON object, so they were left as they are. Set them up again in Settings after removing whispering.connections from this site’s storage.';

/**
 * The saved connections as stored, or nothing when none are. Storage that is
 * there and does not read as one object throws: it is never taken for none,
 * and never replaced by a save.
 */
function storedConnections(): Record<string, unknown> {
	const text = localStorage.getItem(CONNECTIONS_STORAGE);
	if (text === null) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(UNREADABLE_CONNECTIONS);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new Error(UNREADABLE_CONNECTIONS);
	return parsed as Record<string, unknown>;
}

/** One saved connection, read now. Throws when it is saved and does not read as one. */
type AccountSelection = {
	readonly kind: 'epicenter';
	readonly model: string;
	readonly custom?: StoredConnection;
};
type BrowserSelection = StoredConnection | AccountSelection;

function selection(operation: Operation): BrowserSelection | undefined {
	const value = storedConnections()[operation];
	if (value === undefined) return undefined;
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (record.kind === 'epicenter') {
			const custom =
				record.custom === undefined
					? undefined
					: readStoredConnection(record.custom);
			if (
				typeof record.model === 'string' &&
				record.model.trim() !== '' &&
				(record.custom === undefined || custom !== undefined)
			)
				return {
					kind: 'epicenter',
					model: record.model,
					...(custom && { custom }),
				};
		}
	}
	const stored = readStoredConnection(value);
	if (stored === undefined)
		throw new Error(
			`This browser’s ${OPERATION_NAMES[operation]} connection does not read as one. Fix or remove its entry in whispering.connections in this site’s storage, then try again.`,
		);
	return stored;
}

const accountConnection = (model: string): StoredConnection => ({
	baseUrl: `${new URL(getAuth().baseURL).origin}/v1`,
	model,
});

function storedConnection(operation: Operation): StoredConnection | undefined {
	const current = selection(operation);
	return current && 'kind' in current
		? accountConnection(current.model)
		: current;
}

function info(operation: Operation) {
	const current = selection(operation);
	if (current === undefined) return undefined;
	if (!('kind' in current)) return connectionInfo(current);
	const state = getAuth().state;
	return {
		baseUrl: accountConnection(current.model).baseUrl,
		model: current.model,
		keyPresent: false,
		source: 'account' as const,
		readOnlyReason:
			state.status === 'signed-in'
				? 'This connection uses your Epicenter account.'
				: 'Sign in to Epicenter to use this connection.',
	};
}

function readConnections(): ConnectionsInfo {
	return {
		transcription: info('transcription'),
		text: info('text'),
	};
}

function route(operation: Operation) {
	const current = selection(operation);
	if (!current) return undefined;
	if (!('kind' in current))
		return {
			source: 'custom' as const,
			stored: current,
			send: (url: string, init?: RequestInit) => fetch(url, init),
		};
	const state = getAuth().state;
	if (state.status !== 'signed-in')
		throw new Error('Sign in to Epicenter in Settings before sending.');
	return {
		source: 'account' as const,
		stored: accountConnection(current.model),
		send: (url: string, init?: RequestInit) => state.account.fetch(url, init),
	};
}

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * A development build opened with `?fixture=tone` records a generated tone
 * instead of the microphone. A production build never does.
 */
function wantsToneFixture(): boolean {
	return (
		import.meta.env.DEV &&
		new URLSearchParams(location.search).get('fixture') === 'tone'
	);
}

/** Whispering's services in a browser tab: `#platform/services`. */
export const createServices: CreateServices = (folder) => ({
	kind: 'browser',
	location: 'This browser’s storage for this site',
	capture: wantsToneFixture()
		? createFixtureDevice({
				name: 'generated tone',
				load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
			})
		: createWebViewMicrophone(),
	recoverRecordings: async () => undefined,
	transcribe: (request) => {
		let selected: ReturnType<typeof route>;
		return transcribeOverConnection(
			async () => {
				selected = route('transcription');
				return selected?.stored;
			},
			request,
			async () => {
				const { audioPath } = request;
				const { data: bytes, error: readError } = await readBytes(
					folder,
					audioPath,
				);
				if (readError !== null) return Err(readError);
				return Ok({
					bytes,
					filename: audioPath.slice(audioPath.lastIndexOf('/') + 1),
					mimeType: audioMimeTypeOf(audioPath) ?? 'application/octet-stream',
				});
			},
			(url, init) => selected!.send(url, init),
		);
	},
	async transform(request) {
		let selected: ReturnType<typeof route>;
		const answered = await transformOverConnection(
			async () => {
				selected = route('text');
				return selected?.stored;
			},
			request,
			(url, init) => selected!.send(url, init),
		);
		// A browser reports a refused cross-origin request only as a failed
		// fetch, so say what a tab needs that the desktop app does not.
		const { error: transformError } = answered;
		if (transformError?.name === 'Unreachable' && selected?.source === 'custom')
			return TransformationError.Unreachable({
				url: transformError.url,
				reason: `${transformError.reason}. In a browser tab the endpoint must allow requests from ${location.origin} (CORS). Whispering in Epicenter sends from Epicenter and has no such limit`,
			});
		return answered;
	},
	transformNote: `Custom endpoint requests leave this browser tab, so that endpoint must allow requests from ${location.origin} (CORS). The Epicenter account route uses Epicenter’s API.`,
	localTranscription: undefined,
	// One synchronous read and write per change, so a key never sits beside
	// a base URL it was not saved for.
	connections: {
		storedIn: 'this browser’s local storage for this site',
		defaults: {
			transcription: DEFAULT_TRANSCRIPTION_CONNECTION,
			text: { baseUrl: DEFAULT_TRANSCRIPTION_CONNECTION.baseUrl, model: '' },
		},
		read: async () => readConnections(),
		async set(operation, change) {
			try {
				const stored = storedConnections();
				const { data: next, error: changeError } = applyConnectionChange(
					operation,
					'kind' in (selection(operation) ?? {})
						? undefined
						: storedConnection(operation),
					change,
				);
				if (changeError !== null) return Err(changeError);
				localStorage.setItem(
					CONNECTIONS_STORAGE,
					JSON.stringify({ ...stored, [operation]: next }),
				);
				return Ok(readConnections());
			} catch (cause) {
				return Err(describe(cause));
			}
		},
		async useAccount(operation) {
			try {
				const stored = storedConnections();
				const current = selection(operation);
				const model =
					operation === 'transcription'
						? HOSTED_TRANSCRIPTION_MODEL
						: AI_MODELS[0].id;
				localStorage.setItem(
					CONNECTIONS_STORAGE,
					JSON.stringify({
						...stored,
						[operation]: {
							kind: 'epicenter',
							model,
							...((current && 'kind' in current ? current.custom : current) && {
								custom: current && 'kind' in current ? current.custom : current,
							}),
						},
					}),
				);
				return Ok(readConnections());
			} catch (cause) {
				return Err(describe(cause));
			}
		},
		async useCustom(operation) {
			try {
				const stored = storedConnections();
				const current = selection(operation);
				if (current && 'kind' in current && current.custom)
					stored[operation] = current.custom;
				else delete stored[operation];
				localStorage.setItem(CONNECTIONS_STORAGE, JSON.stringify(stored));
				return Ok(readConnections());
			} catch (cause) {
				return Err(describe(cause));
			}
		},
	},
	preferences: localPreferences,
});
