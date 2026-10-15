/**
 * The desktop workspace: Whispering installed in Epicenter (ADR-0493,
 * ADR-0552), over a real directory Epicenter's shell grants this window.
 *
 * The shell opens the window with the folder it hands it as `?folder=<scope>`
 * (`open_installed_app`): Whispering's own folder, `WHISPERING_FOLDER_ID`,
 * `<folder root>/so.epicenter.whispering`, or another folder chosen with "Open
 * in Whispering" (ADR-0560). A window handed no folder opens Whispering's own.
 * Whispering owns its own folder's schema, so it opens that folder with
 * `openFolder`, which publishes `whisperingDefinition`. Any other folder opens
 * with `openDataFolder` and `whisperingDefinition` as the lens (ADR-0538): its
 * declaration is never written, and one that does not contain the lens is
 * refused, named.
 *
 * Either way the page names only the scope: the shell grants the window the
 * directory and holds its lock, and the page's own folder engine reads it,
 * saves to it through the shell, and records history with the `git` the shell
 * runs. The page supplies no path.
 *
 * Everything else native is Epicenter's, granted to Whispering's windows by
 * its app id (`installed-whispering-*` in Epicenter's capabilities):
 *
 * - the recorder plugin, which writes a recording into the granted folder as
 *   it captures (ADR-0543);
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

import {
	CONNECTIONS_FOLDER_ID,
	connectionsLens,
} from '@epicenter/ai/connection-table';
import type { OpenFolderError } from '@epicenter/folder';
import { openDataFolder, openFolder } from '@epicenter/folder/tauri';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from '../audio-format.js';
import {
	DEFAULT_TRANSCRIPTION_CONNECTION,
	whisperingDefinition,
} from '../definition.js';
import { createMicrophoneDevice } from '../microphone.js';
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
	type ConnectionsFolder,
	createDesktopConnections,
	type DesktopConnections,
} from './desktop-connections.js';
import {
	createLocalTranscription,
	type LocalTranscriptionCommands,
} from './local-transcription.js';
import { localPreferences } from './microphone-preference.js';
import {
	WHISPERING_FOLDER_ID,
	type WhisperingFolder,
	type Workspace,
	WorkspaceError,
} from './types.js';

type Route = Awaited<ReturnType<DesktopConnections['route']>>;

/** The scope the shell handed this window as `?folder=`, if any. */
function handedFolder(): string | undefined {
	const handed = new URLSearchParams(globalThis.location?.search).get('folder');
	return handed || undefined;
}

/**
 * The folder's name as a person knows it, its directory's: the shell scopes
 * a listed folder `data:<directory>`, and an app's own folder by its
 * directory, the app's id (`apps/epicenter/src-tauri/src/data_folders.rs`).
 */
function folderName(id: string): string {
	return id.startsWith('data:') ? id.slice('data:'.length) : id;
}

/**
 * Open the folder this window was handed: Whispering's own with its
 * definition, any other through it as a lens. A folder that lacks the lens is
 * refused with its name and what it lacks.
 */
async function openHandedFolder(
	id: string,
): Promise<Result<WhisperingFolder, OpenFolderError>> {
	if (id === WHISPERING_FOLDER_ID)
		return openFolder({ id, definition: whisperingDefinition });
	const { data: folder, error } = await openDataFolder({
		id,
		lens: whisperingDefinition,
	});
	if (error === null) return Ok(folder);
	if (error.name !== 'ShapeMismatch') return Err(error);
	return Err({
		...error,
		message: `Whispering cannot open the folder '${folderName(id)}': ${error.problems.map((problem) => problem.message).join('; ')}.`,
	});
}

export async function openDesktopWorkspace({
	commands: native = commands,
	connectionCommands = commands,
	openConnectionsFolder = () =>
		openDataFolder({ id: CONNECTIONS_FOLDER_ID, lens: connectionsLens }),
}: {
	commands?: LocalTranscriptionCommands;
	/** The AI connection commands; injected for tests. */
	connectionCommands?: ConnectionCommands;
	/** Open `so.epicenter` through its `connections` table; injected for tests. */
	openConnectionsFolder?: () => Promise<
		Result<ConnectionsFolder, { readonly message: string }>
	>;
} = {}): Promise<Result<Workspace, WorkspaceError>> {
	const folderId = handedFolder() ?? WHISPERING_FOLDER_ID;
	const opened = await openHandedFolder(folderId);
	if (opened.error !== null)
		return WorkspaceError.DesktopFolder({ refusal: opened.error });
	const folder = opened.data;
	const root = folder.location.kind === 'directory' ? folder.location.root : '';
	const connections = createDesktopConnections({
		commands: connectionCommands,
		openConnections: openConnectionsFolder,
	});

	async function readBytes(path: string): Promise<Result<Uint8Array, string>> {
		const { data: audio, error } = await folder.files.read(path);
		if (error !== null) return Err(error.message);
		return Ok(audio.bytes);
	}

	async function readAudio(
		path: string,
	): Promise<Result<TranscriptionRequest['audio'], string>> {
		const { data: bytes, error } = await readBytes(path);
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
		folderId,
		location: root,
		terminal: undefined,
		capture: createMicrophoneDevice(),
		captureNotice: undefined,
		reveal: undefined,
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
			readAudio: readBytes,
		}),
		connections: {
			storedIn:
				'Epicenter’s AI connections, which follow you wherever Epicenter’s folder syncs; the endpoint and key are kept in this computer’s keychain',
			defaults: {
				transcription: DEFAULT_TRANSCRIPTION_CONNECTION,
				text: { baseUrl: DEFAULT_TRANSCRIPTION_CONNECTION.baseUrl, model: '' },
			},
			read: connections.read,
			set: connections.set,
			// Only a browser tab can hold a key an earlier build saved.
			adoptLegacyKey: async () =>
				Err('No key from an earlier version is saved in Epicenter.'),
		},
		preferences: localPreferences,
		debugControls: false,
		injection: undefined,
		// Closing the folders waits for the saves already under way and commits
		// nothing.
		close: async () => {
			await Promise.all([folder.close(), connections.close()]);
		},
	});
}
