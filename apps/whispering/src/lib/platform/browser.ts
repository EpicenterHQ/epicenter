/** Browser capture, requests and device preferences over the folder the app opened. */
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
import { transcribeOverConnection } from '../transcription.js';
import {
	TransformationError,
	transformOverConnection,
} from '../transformation.js';
import { createWebViewMicrophone } from '../webview-microphone.js';
import { localPreferences } from './microphone-preference.js';
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
function storedConnection(operation: Operation): StoredConnection | undefined {
	const value = storedConnections()[operation];
	if (value === undefined) return undefined;
	const stored = readStoredConnection(value);
	if (stored === undefined)
		throw new Error(
			`This browser’s ${OPERATION_NAMES[operation]} connection does not read as one. Fix or remove its entry in whispering.connections in this site’s storage, then try again.`,
		);
	return stored;
}

function readConnections(): ConnectionsInfo {
	const transcription = storedConnection('transcription');
	const text = storedConnection('text');
	return {
		transcription: transcription && connectionInfo(transcription),
		text: text && connectionInfo(text),
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

/** The `#platform/services` leaf of every build Epicenter does not serve. */
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
	transcribe: (request) =>
		transcribeOverConnection(
			async () => storedConnection('transcription'),
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
		),
	async transform(request) {
		const answered = await transformOverConnection(
			async () => storedConnection('text'),
			request,
		);
		// A browser reports a refused cross-origin request only as a failed
		// fetch, so say what a tab needs that the desktop app does not.
		const { error: transformError } = answered;
		if (transformError?.name === 'Unreachable')
			return TransformationError.Unreachable({
				url: transformError.url,
				reason: `${transformError.reason}. In a browser tab the endpoint must allow requests from ${location.origin} (CORS). Whispering in Epicenter sends from Epicenter and has no such limit`,
			});
		return answered;
	},
	transformNote: `Requests are sent from this browser tab over the text connection in Settings, so its endpoint must allow requests from ${location.origin} (CORS). Most hosted providers refuse that; a local endpoint or Whispering in Epicenter works.`,
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
					storedConnection(operation),
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
	},
	preferences: localPreferences,
});
