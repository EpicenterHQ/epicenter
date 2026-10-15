/**
 * The browser workspace: a logical folder and its Git history in OPFS.
 *
 * The same tables, files, and history as the desktop folder, in a private browser
 * directory. The terminal is the in-page shell over those files, and
 * transcription requests go straight from the page, so the endpoint must allow
 * this origin.
 *
 * The opener is the browser one, named explicitly. It refuses inside a
 * desktop app or when browser storage cannot be opened. Any refusal is what
 * the person is shown: nothing else is opened in its place.
 */
import { openFolder } from '@epicenter/folder/browser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from '../audio-format.js';
import { createFixtureDevice, toneWav } from '../capture.js';
import {
	adoptLegacyKey,
	applyConnectionChange,
	type ConnectionsInfo,
	connectionInfo,
	OPERATION_NAMES,
	OPERATIONS,
	type Operation,
	readStoredConnection,
	type StoredConnection,
} from '../connections.js';
import {
	DEFAULT_TRANSCRIPTION_CONNECTION,
	whisperingDefinition,
} from '../definition.js';
import { createMicrophoneDevice } from '../microphone.js';
import { transcribeOverConnection } from '../transcription.js';
import {
	TransformationError,
	transformOverConnection,
} from '../transformation.js';
import { localPreferences } from './microphone-preference.js';
import {
	WHISPERING_FOLDER_ID,
	type Workspace,
	WorkspaceError,
} from './types.js';

/** This tab's two connections, keys included, as one JSON object. */
const CONNECTIONS_STORAGE = 'whispering.connections';
/** Where an earlier build kept its one key. Read only to move it into a connection. */
const LEGACY_KEY_STORAGE = 'whispering.transcriptionApiKey';

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
		legacyKey: (localStorage.getItem(LEGACY_KEY_STORAGE) ?? '') !== '',
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

export async function openBrowserWorkspace(): Promise<
	Result<Workspace, WorkspaceError>
> {
	const { data: folder, error: openError } = await openFolder({
		id: WHISPERING_FOLDER_ID,
		definition: whisperingDefinition,
		browser: {
			author: { name: 'Whispering', email: 'whispering@localhost' },
		},
	});
	if (openError !== null)
		return WorkspaceError.BrowserFolder({ refusal: openError });

	return Ok({
		kind: 'browser',
		folder,
		folderId: WHISPERING_FOLDER_ID,
		location: 'Private files for this site in this browser',
		terminal: undefined,
		capture: wantsToneFixture()
			? createFixtureDevice({
					name: 'generated tone',
					load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
				})
			: createMicrophoneDevice(),
		captureNotice: undefined,
		reveal: undefined,
		transcribe: (request) =>
			transcribeOverConnection(
				async () => storedConnection('transcription'),
				request,
				async () => {
					const { data: audio, error: readError } = await folder.files.read(
						request.audioPath,
					);
					if (readError !== null) return Err(readError.message);
					const { audioPath } = request;
					return Ok({
						bytes: audio.bytes,
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
			async adoptLegacyKey(targets) {
				try {
					const stored = storedConnections();
					const { data: adopted, error: adoptError } = adoptLegacyKey(
						localStorage.getItem(LEGACY_KEY_STORAGE) ?? '',
						targets,
						{},
					);
					if (adoptError !== null) return Err(adoptError);
					const next = { ...stored };
					for (const operation of OPERATIONS)
						if (adopted[operation] !== undefined) {
							storedConnection(operation);
							next[operation] = adopted[operation];
						}
					localStorage.setItem(CONNECTIONS_STORAGE, JSON.stringify(next));
					localStorage.removeItem(LEGACY_KEY_STORAGE);
					return Ok(readConnections());
				} catch (cause) {
					return Err(describe(cause));
				}
			},
		},
		preferences: localPreferences,
		debugControls: import.meta.env.DEV,
		injection: undefined,
		close: () => folder.close(),
	});
}
