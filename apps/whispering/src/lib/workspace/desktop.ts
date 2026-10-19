/**
 * The desktop workspace: Whispering installed in Epicenter (ADR-0493,
 * ADR-0552), over an ordinary directory Epicenter's shell grants this window.
 *
 * Epicenter hands this window a directory scope, normally Whispering's own
 * folder and sometimes one chosen through "Open in Whispering". The page
 * opens that scope with Whispering's tables
 * (`openFolder({ directory, tables })`). The page supplies no path: the shell
 * grants the window the directory, checks every path, and lands each save.
 * Files a person or another program left in the directory are read as they
 * are, and opening writes nothing.
 *
 * Everything else native is Epicenter's, granted to every installed app's
 * windows (`installed-app.json` in Epicenter's capabilities):
 *
 * - the recorder plugin, which owns the microphone: it lists the inputs,
 *   reads one's level, and writes a recording into the granted directory as
 *   it captures, and the page opens no microphone of its own (ADR-0543,
 *   ADR-0571, `desktop-microphone.ts`);
 * - the two connections, rows of Epicenter's own folder `so.epicenter`, whose
 *   endpoints and keys stay in this computer's keychain; requests go through
 *   the `epicenter` CLI, which adds the key (`desktop-connections.ts`);
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

import { OpenFolderError, type Folder } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/tauri';
import { recoverRecordings } from '@epicenter/recorder/tauri';
import { invoke } from '@tauri-apps/api/core';
import type { TSchema } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from '../audio-format.js';
import {
	AUDIO,
	DEFAULT_TRANSCRIPTION_CONNECTION,
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
	CONNECTIONS_FOLDER_ID,
	type ConnectionCommands,
	type ConnectionsFolder,
	connectionsTables,
	createDesktopConnections,
	type DesktopConnections,
} from './desktop-connections.js';
import { createDesktopMicrophone } from './desktop-microphone.js';
import {
	createLocalTranscription,
	type LocalTranscriptionCommands,
} from './local-transcription.js';
import { localPreferences } from './microphone-preference.js';
import {
	type OpenWorkspace,
	WHISPERING_FOLDER_ID,
	type Workspace,
	WorkspaceError,
} from './types.js';

type Route = Awaited<ReturnType<DesktopConnections['route']>>;

/**
 * Opens the directory the shell registered as `directory`, with `tables`:
 * `@epicenter/folder/tauri`'s opener. Injected for tests.
 */
export type OpenDirectory = <
	const TTables extends Record<string, TSchema>,
>(options: {
	readonly directory: string;
	readonly tables: TTables;
}) => Promise<Result<Folder<TTables>, OpenFolderError>>;

/**
 * The desktop opener over a directory the shell registered (ADR-0636):
 * `@epicenter/folder/tauri`'s `openFolder({ directory, tables })`.
 */
const openRegistered: OpenDirectory = ({ directory, tables }) =>
	openFolder({ directory, tables });

export async function openDesktopWorkspace({
	openDirectory = openRegistered,
	directory = WHISPERING_FOLDER_ID,
	commands: native = commands,
	connectionCommands = commands,
	openConnectionsFolder = () =>
		openDirectory({
			directory: CONNECTIONS_FOLDER_ID,
			tables: connectionsTables,
		}),
}: {
	/** How a registered directory is opened; injected for tests. */
	openDirectory?: OpenDirectory;
	/** The registered directory Whispering opens: its own unless a test says otherwise. */
	directory?: string;
	commands?: LocalTranscriptionCommands;
	/** The AI connection commands; injected for tests. */
	connectionCommands?: ConnectionCommands;
	/** Open `so.epicenter` with its `connections` table; injected for tests. */
	openConnectionsFolder?: () => Promise<
		Result<ConnectionsFolder, { readonly message: string }>
	>;
} = {}): Promise<Result<Workspace, WorkspaceError>> {
	const opened = await openDirectory({ directory, tables: whisperingTables });
	if (opened.error !== null)
		return WorkspaceError.DesktopFolder({ refusal: opened.error });
	const folder = opened.data;
	// Repair the recordings a quit or a crash cut off, before anything reads
	// them. A failure keeps the folder open and is shown beside the recorder.
	const { error: recoverError } = await recoverRecordings({
		folder: { id: directory, write: folder.files.write },
		under: AUDIO,
	});
	const captureNotice =
		recoverError === null
			? undefined
			: `Recordings a quit cut off could not be checked: ${recoverError.message}`;
	const connections = createDesktopConnections({
		commands: connectionCommands,
		openConnections: openConnectionsFolder,
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
		folderId: directory,
		location: `The folder Epicenter keeps as ${directory}`,
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
		close: async () => {
			await Promise.all([folder.close(), connections.close()]);
		},
	});
}

/** The `#platform/workspace` leaf of the build Epicenter serves. */
export const openWorkspace: OpenWorkspace = async () => {
	let handed: { app: string; folder: string } | null;
	try {
		handed = await invoke('plugin:epicenter-folder|window_folder');
	} catch (cause) {
		return WorkspaceError.DesktopFolder({
			refusal: OpenFolderError.Unavailable({ cause }).error,
		});
	}
	if (handed === null || handed.app !== WHISPERING_FOLDER_ID)
		return WorkspaceError.DesktopFolder({
			refusal: OpenFolderError.Unavailable({
				cause: new Error('Epicenter did not hand this Whispering window a folder'),
			}).error,
		});
	return openDesktopWorkspace({ directory: handed.folder });
};
