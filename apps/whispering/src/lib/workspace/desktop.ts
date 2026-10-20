/**
 * The desktop workspace: Whispering in Epicenter (ADR-0493), over the
 * ordinary directory Epicenter's shell bound to this window.
 *
 * Epicenter binds this window one folder before the window exists: the
 * Whispering default under the Epicenter folder, a folder the Folders window
 * listed, or one the person chose in the native picker. The page opens it
 * with Whispering's tables (`openFolder({ tables })`), and the recorder
 * writes into the same folder. The page names no path, scope, or window:
 * the shell checks every path and lands each save in the window's directory.
 * Files a person or another program left in the directory are read as they
 * are, and opening writes nothing.
 *
 * Everything else native is Epicenter's, granted to Whispering's windows
 * (`whispering.json` in Epicenter's capabilities):
 *
 * - the recorder plugin, which owns the microphone: it lists the inputs,
 *   reads one's level, and writes a recording into the granted directory as
 *   it captures, and the page opens no microphone of its own (ADR-0543,
 *   ADR-0571, `desktop-microphone.ts`);
 * - the two connections, rows of Epicenter's own folder `so.epicenter`, which
 *   Epicenter reads and saves by operation, so this window opens no second
 *   folder; their endpoints and keys stay in this computer's keychain, and
 *   requests go through the `epicenter` CLI, which adds the key
 *   (`desktop-connections.ts`);
 * - transcription with Epicenter's active local model
 *   (`local-transcription.ts`).
 *
 * The chosen microphone is kept in this origin's storage, which lasts:
 * Epicenter serves every app from one fixed loopback origin.
 *
 * A refused folder is returned as that refusal, and nothing else is opened in
 * its place. A request whose reply never arrived from Epicenter is reported as
 * unknown, never as "not sent", and nothing is sent again on its own.
 */

import type { Folder, OpenFolderError } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/tauri';
import { recoverRecordings } from '@epicenter/recorder/tauri';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from '../audio-format.js';
import {
	AUDIO,
	DEFAULT_TRANSCRIPTION_CONNECTION,
	type WhisperingTables,
	whisperingTables,
} from '../definition.js';
import { readBytes } from '../files.js';
import { commands } from '../tauri/bindings.gen.js';
import {
	TranscriptionError,
	type TranscriptionRequest,
	transcribeOverConnection,
} from '../transcription.js';
import {
	TransformationError,
	transformOverConnection,
} from '../transformation.js';
import {
	type ConnectionCommands,
	createDesktopConnections,
	type DesktopConnections,
} from './desktop-connections.js';
import { createDesktopMicrophone } from './desktop-microphone.js';
import {
	createLocalTranscription,
	type LocalTranscriptionCommands,
} from './local-transcription.js';
import { localPreferences } from './microphone-preference.js';
import { type OpenWorkspace, type Workspace, WorkspaceError } from './types.js';

type Route = Awaited<ReturnType<DesktopConnections['route']>>;

/**
 * Opens this window's folder with Whispering's tables:
 * `@epicenter/folder/tauri`'s `openFolder({ tables })`. Injected for tests.
 */
export type OpenWindowFolder = () => Promise<
	Result<Folder<WhisperingTables>, OpenFolderError>
>;

const openWindowFolder: OpenWindowFolder = () =>
	openFolder({ tables: whisperingTables });

export async function openDesktopWorkspace({
	openFolder: open = openWindowFolder,
	commands: native = commands,
	connectionCommands = commands,
}: {
	/** How this window's folder is opened; injected for tests. */
	openFolder?: OpenWindowFolder;
	commands?: LocalTranscriptionCommands;
	/** The AI connection commands and connection rows; injected for tests. */
	connectionCommands?: ConnectionCommands;
} = {}): Promise<Result<Workspace, WorkspaceError>> {
	const opened = await open();
	if (opened.error !== null)
		return WorkspaceError.DesktopFolder({ refusal: opened.error });
	const folder = opened.data;
	// Repair the recordings a quit or a crash cut off, before anything reads
	// them. A failure keeps the folder open and is shown beside the recorder.
	const { error: recoverError } = await recoverRecordings({ under: AUDIO });
	const captureNotice =
		recoverError === null
			? undefined
			: `Recordings a quit cut off could not be checked: ${recoverError.message}`;
	const connections = createDesktopConnections({
		commands: connectionCommands,
	});

	const readAudioBytes = (path: string) => readBytes(folder, path);

	async function readAudio(
		path: string,
	): Promise<Result<TranscriptionRequest['audio'], string>> {
		const { data: bytes, error } = await readAudioBytes(path);
		if (error !== null) return Err(error);
		return Ok({
			bytes,
			filename: path.slice(path.lastIndexOf('/') + 1),
			mimeType: audioMimeTypeOf(path) ?? 'application/octet-stream',
		});
	}

	return Ok({
		kind: 'native',
		folder,
		location: 'The folder opened in Epicenter',
		capture: createDesktopMicrophone(),
		captureNotice,
		async transcribe(request) {
			let route: Route;
			const answered = await transcribeOverConnection(
				async () => {
					route = await connections.route('transcription');
					return route?.stored;
				},
				request,
				() => readAudio(request.audioPath),
				(url, init) => (route as NonNullable<Route>).send(url, init),
			);
			// The request went to the epicenter command, which may have sent it
			// on: a reply that never came back says nothing about the endpoint.
			const { error } = answered;
			if (error?.name === 'Unreachable')
				return TranscriptionError.HostUnavailable({ reason: error.reason });
			return answered;
		},
		async transform(request) {
			let route: Route;
			const answered = await transformOverConnection(
				async () => {
					route = await connections.route('text');
					return route?.stored;
				},
				request,
				(url, init) => (route as NonNullable<Route>).send(url, init),
			);
			const { error } = answered;
			if (error?.name === 'Unreachable')
				return TransformationError.HostUnavailable({ reason: error.reason });
			return answered;
		},
		transformNote:
			'Requests are sent by Epicenter, not by this window, over the text connection in Settings. Its endpoint and key stay in this computer’s keychain and are never given to the window or written to a folder.',
		localTranscription: createLocalTranscription({
			commands: native,
			readAudio: readAudioBytes,
		}),
		connections: {
			storedIn:
				'Epicenter’s AI connections, rows of Epicenter’s own folder; the endpoint and key are kept in this computer’s keychain',
			defaults: {
				transcription: DEFAULT_TRANSCRIPTION_CONNECTION,
				text: { baseUrl: DEFAULT_TRANSCRIPTION_CONNECTION.baseUrl, model: '' },
			},
			read: connections.read,
			set: connections.set,
		},
		preferences: localPreferences,
		// Closing waits for the saves already under way.
		close: () => folder.close(),
	});
}

/**
 * The `#platform/workspace` leaf of the build Epicenter serves: open the
 * folder the shell bound to this window. A window bound to none is refused,
 * and nothing else is opened.
 */
export const openWorkspace: OpenWorkspace = () => openDesktopWorkspace();
