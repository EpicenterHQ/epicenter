/**
 * The desktop workspace: Whispering installed in Epicenter (ADR-0493,
 * ADR-0552), over a real directory Epicenter's shell grants this window.
 *
 * The shell opens the window with the folder it hands it as `?folder=<scope>`
 * (`open_installed_app`): Whispering's own folder, `WHISPERING_FOLDER_ID`,
 * `<folder root>/so.epicenter.whispering`, or another folder chosen with "Open
 * in Whispering" (ADR-0560). A window handed no folder opens Whispering's own.
 * Whispering owns its own folder's schema, so `openHandedFolder` publishes
 * `whisperingDefinition` to that folder and reads any other through it as a
 * lens (ADR-0538): its declaration is never written, and one that does not
 * contain the lens is refused, named.
 *
 * Either way the page names only the scope: the shell grants the window the
 * directory and holds its lock, and the page's own folder engine reads it,
 * saves to it through the shell, and records history with the `git` the shell
 * runs. The page supplies no path.
 *
 * Everything else native is Epicenter's, granted to every installed app's
 * windows (`installed-app.json` in Epicenter's capabilities):
 *
 * - the recorder plugin, which owns the microphone: it lists the inputs,
 *   reads one's level, and writes a recording into the granted folder as it
 *   captures, and the page opens no microphone of its own (ADR-0543,
 *   ADR-0571, `desktop-microphone.ts`);
 * - AI connections, rows of Epicenter's own folder `so.epicenter`, whose
 *   endpoints and keys stay in this computer's keychain; requests go through
 *   the `epicenter` CLI, which adds the key (ADR-0557);
 * - transcription with Epicenter's local models, which a `local` connection
 *   reaches (`local-transcription.ts`).
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
	epicenterDefinition,
} from '@epicenter/ai/connection-table';
import { sendThroughShell } from '@epicenter/ai/send';
import { keychainKeys } from '@epicenter/ai/ui';
import { openDataFolder, openHandedFolder } from '@epicenter/folder/tauri';
import { recoverRecordings } from '@epicenter/recorder/tauri';
import { Channel } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { AUDIO, whisperingDefinition } from '../definition.js';
import { type CliError, commands } from '../tauri/bindings.gen.js';
import { createDesktopMicrophone } from './desktop-microphone.js';
import {
	createLocalTranscription,
	type LocalTranscriptionCommands,
} from './local-transcription.js';
import { localPreferences } from './microphone-preference.js';
import {
	type ConnectionsFolder,
	type OpenWorkspace,
	WHISPERING_FOLDER_ID,
	type Workspace,
	WorkspaceError,
} from './types.js';

/** The AI connection commands, as the generated bindings type them. */
export type ConnectionCommands = Pick<
	typeof commands,
	'aiKeyState' | 'aiKeySet' | 'aiKeyRemove' | 'aiSend' | 'authStatus'
>;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** What a person is told when a CLI command did not run or was refused. */
const failureOf = (error: CliError) =>
	error.name === 'NotGranted'
		? 'This window was not granted Epicenter’s folder.'
		: error.message;

/**
 * Refusals `epicenter send` names before it sends anything. Anything else
 * that ends a request without a response, the shell failing or the
 * endpoint failing past the CLI, leaves what was sent unknown.
 */
const REFUSED_BEFORE_SENDING = new Set([
	'InvalidRequest',
	'NoKey',
	'EndpointChanged',
	'NoAccessToken',
	'NoAccountToken',
	'LocalNotSent',
	'KeychainUnavailable',
	'EntryUnreadable',
	'NotGranted',
	'Refused',
]);

export async function openDesktopWorkspace({
	commands: native = commands,
	connectionCommands = commands,
	openConnectionsFolder = () =>
		openDataFolder({ id: CONNECTIONS_FOLDER_ID, lens: epicenterDefinition }),
}: {
	commands?: LocalTranscriptionCommands;
	/** The AI connection commands; injected for tests. */
	connectionCommands?: ConnectionCommands;
	/** Open `so.epicenter` through its `connections` table; injected for tests. */
	openConnectionsFolder?: () => Promise<
		Result<ConnectionsFolder, { readonly message: string }>
	>;
} = {}): Promise<Result<Workspace, WorkspaceError>> {
	const opened = await openHandedFolder({
		ownId: WHISPERING_FOLDER_ID,
		definition: whisperingDefinition,
		appTitle: 'Whispering',
	});
	if (opened.error !== null)
		return WorkspaceError.DesktopFolder({ refusal: opened.error });
	const { folder, id: folderId } = opened.data;
	// Repair the recordings a quit or a crash cut off, before anything reads
	// them. A failure keeps the folder open and is shown beside the recorder.
	const { error: recoverError } = await recoverRecordings({
		folder: { id: folderId, files: folder.files },
		under: AUDIO,
	});
	const captureNotice =
		recoverError === null
			? undefined
			: `Recordings a quit cut off could not be checked: ${recoverError.message}`;
	const root = folder.location.kind === 'directory' ? folder.location.root : '';
	// Opened when first asked for, once; a failed open is tried again.
	let connectionsFolder: Promise<Result<ConnectionsFolder, string>> | undefined;
	function openConnections() {
		connectionsFolder ??= openConnectionsFolder().then(({ data, error }) => {
			if (error === null) return Ok(data);
			connectionsFolder = undefined;
			return Err(`Epicenter’s folder did not open: ${error.message}`);
		});
		return connectionsFolder;
	}

	async function readBytes(path: string): Promise<Result<Uint8Array, string>> {
		const { data: audio, error } = await folder.files.read(path);
		if (error !== null) return Err(error.message);
		return Ok(audio.bytes);
	}

	return Ok({
		kind: 'native',
		folder,
		folderId,
		location: root,
		terminal: undefined,
		capture: createDesktopMicrophone(),
		captureNotice,
		reveal: undefined,
		localTranscription: createLocalTranscription({
			commands: native,
			readAudio: readBytes,
		}),
		connections: {
			kinds: ['openai-compatible', 'epicenter', 'local'],
			keys: keychainKeys({
				aiKeyState: connectionCommands.aiKeyState,
				aiKeySet: connectionCommands.aiKeySet,
				aiKeyRemove: connectionCommands.aiKeyRemove,
				describe: failureOf,
			}),
			epicenterNote:
				'Sends to your Epicenter account with Epicenter’s sign-in, under Account in Epicenter’s Settings.',
			note: 'Requests are sent by Epicenter, not by this window. A connection’s endpoint and key stay in this computer’s keychain and are never given to the window or written to a folder.',
			open: openConnections,
			async epicenterEndpoint() {
				const { data: status, error } = await connectionCommands.authStatus();
				if (error !== null) return Err(failureOf(error));
				const signedIn = status.grants.some(
					(grant) => grant.grant === 'desktop' && grant.signedIn,
				);
				if (!signedIn)
					return Err('sign in under Account in Epicenter’s Settings');
				return Ok(`${new URL(status.origin).origin}/v1`);
			},
			async send(target, request) {
				try {
					return Ok(
						await sendThroughShell(request, async (wire, onLine) => {
							const channel = new Channel<string>();
							channel.onmessage = onLine;
							const { error } = await connectionCommands.aiSend(
								target,
								wire,
								channel,
							);
							return error && { name: error.name, message: failureOf(error) };
						}),
					);
				} catch (cause) {
					const name = cause instanceof Error ? cause.name : '';
					return Err({
						message: REFUSED_BEFORE_SENDING.has(name)
							? describe(cause)
							: `Epicenter did not answer, so it is not known whether the request was sent or what came back: ${describe(cause)}. Nothing is sent again unless you try again.`,
					});
				}
			},
		},
		preferences: localPreferences,
		debugControls: false,
		injection: undefined,
		// Closing the folders waits for the saves already under way and commits
		// nothing.
		close: async () => {
			const opened = await connectionsFolder;
			await Promise.all([folder.close(), opened?.data?.close()]);
		},
	});
}

/** The `#platform/workspace` leaf of the build Epicenter serves. */
export const openWorkspace: OpenWorkspace = () => openDesktopWorkspace();
