/**
 * The desktop workspace: Whispering installed in Epicenter (ADR-0493,
 * ADR-0552), over a real directory Epicenter's shell grants this window.
 *
 * Epicenter hands an installed app opened from its Apps list its own folder,
 * `<folder root>/so.epicenter.whispering`, under the scope of the same name.
 * This opens it through `@epicenter/folder/tauri`, naming only that scope:
 * the shell grants the window the directory and holds its lock, and the
 * page's own folder engine reads it, saves to it through the shell, and
 * records history with the `git` the shell runs. The page supplies no path.
 *
 * Everything else native is Epicenter's, granted to Whispering's windows by
 * its app id (`installed-whispering-*` in Epicenter's capabilities):
 *
 * - the recorder plugin, which writes a recording into the granted folder as
 *   it captures (ADR-0543);
 * - the two connections, entries in Epicenter's AI connections, whose keys
 *   stay in the system keychain; requests go through Epicenter's host, which
 *   adds the key (`epicenter-connections.ts`);
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

import { openFolder } from '@epicenter/folder/tauri';
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
	createEpicenterConnections,
	type EpicenterConnections,
	type Send,
} from './epicenter-connections.js';
import {
	createLocalTranscription,
	type LocalTranscriptionCommands,
} from './local-transcription.js';
import { localPreferences } from './microphone-preference.js';
import {
	WHISPERING_FOLDER_ID,
	type Workspace,
	WorkspaceError,
} from './types.js';

type Route = Awaited<ReturnType<EpicenterConnections['route']>>;

export async function openDesktopWorkspace({
	origin,
	fetch: send = (input, init) => globalThis.fetch(input, init),
	commands: native = commands,
}: {
	/** The Epicenter host's origin, which served this page. */
	origin: string;
	fetch?: Send;
	commands?: LocalTranscriptionCommands;
}): Promise<Result<Workspace, WorkspaceError>> {
	const opened = await openFolder({
		id: WHISPERING_FOLDER_ID,
		definition: whisperingDefinition,
	});
	if (opened.error !== null)
		return WorkspaceError.DesktopFolder({ refusal: opened.error });
	const folder = opened.data;
	const root = folder.location.kind === 'directory' ? folder.location.root : '';
	const connections = createEpicenterConnections({ origin, send });

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
			// The request went to Epicenter's host, which may have sent it on:
			// a reply that never came back says nothing about the endpoint.
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
			'Requests are sent by Epicenter, not by this window, over the text connection in Settings. Its key stays in the system keychain and is never given to the window or written to the folder.',
		localTranscription: createLocalTranscription({
			commands: native,
			readAudio: readBytes,
		}),
		connections: {
			storedIn:
				'Epicenter’s AI connections on this computer, which other apps in Epicenter can use too; the key is kept in the system keychain',
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
		// Closing the folder waits for the saves already under way and commits
		// nothing.
		close: () => folder.close(),
	});
}
