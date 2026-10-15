/**
 * The desktop workspace: a real directory the desktop shell grants this
 * window, and the Whispering host for everything else native.
 *
 * The shell registered one directory for this window and decides where it
 * is. This opens it through `@epicenter/folder/tauri`, naming only the
 * folder's ID: the shell grants the window that directory and holds its lock,
 * and the page's own folder engine reads it, saves to it through the shell,
 * and records history with the `git` the shell runs. The page supplies no
 * path.
 *
 * The host that serves this page does the rest: the terminal is the person's
 * shell in that directory, transcription and text requests leave from the
 * host over the device's two connections, the microphone chosen on this
 * device is kept beside them. The host holds no folder. Nothing reports what its terminal
 * or any other program writes: the library reads again after each terminal
 * command and when the person returns to the window.
 *
 * Both are required to open. A host that does not answer, a shell that
 * refuses the folder, and the two naming different directories are each
 * returned as that refusal, and nothing else is opened in their place.
 *
 * Once open, the two fail apart. If the host stops, the folder is still
 * granted and still open: saves and commits keep working, and only
 * what the host did is unavailable. A reply the host never delivered says
 * nothing about whether it acted, so a lost transcription or transformation
 * reply is reported as unknown, never as "not sent", and nothing is sent again
 * on its own.
 */

import { openFolder } from '@epicenter/folder/tauri';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type BridgeConnection, createHttpBridge } from '../bridge/http.js';
import {
	type CaptureDevice,
	createFixtureDevice,
	type MicrophonePreference,
} from '../capture.js';
import type { ConnectionDefaults, ConnectionsInfo } from '../connections.js';
import { whisperingDefinition } from '../definition.js';
import { createMicrophoneDevice } from '../microphone.js';
import { TranscriptionError } from '../transcription.js';
import { TransformationError } from '../transformation.js';
import {
	type InjectionState,
	WHISPERING_FOLDER_ID,
	type Workspace,
	WorkspaceError,
} from './types.js';

/** What the host reports about itself. Mirrors `HostInfo` in `native/host.ts`. */
type HostInfo = {
	readonly root: string;
	readonly shell: string;
	readonly debug: boolean;
	readonly fixture: { readonly name: string; readonly size: number } | null;
	readonly fixtureRefused: boolean;
	readonly defaults: ConnectionDefaults;
};

/** What the host remembers for this device. Mirrors `DevicePreferences` in `native/host.ts`. */
type DevicePreferences = {
	readonly microphone: MicrophonePreference | null;
};

type ShellRun = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly cwd: string;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export async function openDesktopWorkspace(
	connection: BridgeConnection,
): Promise<Result<Workspace, WorkspaceError>> {
	const bridge = createHttpBridge(connection);
	// The host first: without it there is no app to open a folder for, so the
	// shell is not asked for anything.
	let info: HostInfo;
	try {
		info = await bridge.app<HostInfo>('info');
	} catch (cause) {
		return WorkspaceError.HostUnreachable({ reason: describe(cause) });
	}
	const { data: folder, error: openError } = await openFolder({
		id: WHISPERING_FOLDER_ID,
		definition: whisperingDefinition,
	});
	if (openError !== null)
		return WorkspaceError.DesktopFolder({ refusal: openError });
	// The shell gave one directory to both. Were they to differ, the terminal
	// and transcription would use a directory the saves do not go to.
	const root = folder.location.kind === 'directory' ? folder.location.root : '';
	if (root !== info.root) {
		await folder.close();
		return WorkspaceError.FolderMismatch({ folder: root, host: info.root });
	}
	// The folder is open, so Git exists: a debug host may now take the branch
	// lock its launch asked for. The host reports a refusal itself.
	if (info.debug) await bridge.app('injection-launch').catch(() => {});

	// The folder-relative directory the next command starts in.
	let cwd = '';
	const shown = (relative: string) => (relative === '' ? '/' : `/${relative}`);

	const capture: CaptureDevice =
		info.fixture === null
			? createMicrophoneDevice()
			: createFixtureDevice({
					name: info.fixture.name,
					load: () =>
						bridge.app<{ name: string; bytes: Uint8Array }>('fixture'),
				});

	return Ok({
		kind: 'native',
		folder,
		location: root,
		terminal: {
			get cwd() {
				return shown(cwd);
			},
			async exec(command) {
				const run = await bridge.app<ShellRun>('terminal', { command, cwd });
				cwd = run.cwd;
				return run;
			},
			note: `${info.shell} in ${root}. Each command is a new shell that starts in the directory the last one ended in; there is no interactive terminal device, so full-screen programs do not run.`,
		},
		capture,
		captureNotice: info.fixtureRefused
			? 'WHISPERING_AUDIO_FIXTURE is set, but this build does not allow fixture audio. Recordings use the microphone.'
			: info.fixture?.size === 0
				? `The fixture file ${info.fixture.name} could not be read. Recordings will fail until it can.`
				: undefined,
		async reveal() {
			try {
				await bridge.app('reveal');
				return undefined;
			} catch (cause) {
				return describe(cause);
			}
		},
		// The bridge rejects when the host is unreachable, faults, or its reply is
		// lost; a workspace answers with a Result either way. A rejection does
		// not say the endpoint was not called, and the call is not made again.
		async transcribe({ audioPath, expectedBaseUrl, model }) {
			try {
				return await bridge.app<Awaited<ReturnType<Workspace['transcribe']>>>(
					'transcribe',
					{ path: audioPath, expectedBaseUrl, model },
				);
			} catch (cause) {
				return TranscriptionError.HostUnavailable({ reason: describe(cause) });
			}
		},
		async transform(request) {
			try {
				return await bridge.app<Awaited<ReturnType<Workspace['transform']>>>(
					'transform',
					request,
				);
			} catch (cause) {
				return TransformationError.HostUnavailable({ reason: describe(cause) });
			}
		},
		transformNote:
			'Requests are sent by Whispering’s host, not by this window, over the text connection in Settings. Its key is never given to the window or written to the folder.',
		// The host holds the keys and answers with what is set, never a key.
		connections: {
			storedIn:
				'this folder’s private .git directory; Git never commits it, but copying the whole directory carries it',
			defaults: info.defaults,
			read: () => bridge.app<ConnectionsInfo>('connections'),
			async set(operation, change) {
				try {
					return Ok(
						await bridge.app<ConnectionsInfo>('set-connection', {
							operation,
							...change,
						}),
					);
				} catch (cause) {
					return Err(describe(cause));
				}
			},
			async adoptLegacyKey(targets) {
				try {
					return Ok(
						await bridge.app<ConnectionsInfo>('adopt-legacy-key', { targets }),
					);
				} catch (cause) {
					return Err(describe(cause));
				}
			},
		},
		// The page is served from a new port on every launch, so its own storage
		// does not last. The host keeps the choice in the device file instead.
		preferences: {
			microphone: async () =>
				(await bridge.app<DevicePreferences>('preferences')).microphone ??
				undefined,
			async setMicrophone(microphone) {
				try {
					await bridge.app('set-preferences', {
						microphone: microphone ?? null,
					});
					return undefined;
				} catch (cause) {
					return describe(cause);
				}
			},
		},
		debugControls: info.debug,
		injection: info.debug
			? {
					state: () => bridge.app<InjectionState>('injection'),
					arm: (change) => bridge.app<InjectionState>('inject', change),
					// The host only places and removes the obstacle. A host that cannot
					// be asked places none, and the write is made all the same.
					async aroundRecordingWrite(write, run) {
						const placed = await bridge
							.app<{ obstacle: string | null }>('obstruct', write)
							.catch(() => undefined);
						try {
							return await run();
						} finally {
							if (placed?.obstacle != null)
								await bridge
									.app('unobstruct', { obstacle: placed.obstacle })
									.catch(() => {});
						}
					},
				}
			: undefined,
		// Closing the folder waits for the saves already under way and commits
		// nothing.
		close: () => folder.close(),
	});
}
