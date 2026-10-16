/**
 * The one boundary between Whispering and where its files live.
 *
 * Inside Epicenter, Whispering reaches a real directory Epicenter's shell
 * grants it, and its connections and local transcription through Epicenter;
 * a browser tab keeps a logical folder in OPFS. Everything above this type
 * is the same code for both. Capabilities a storage cannot offer are
 * `undefined` here, not emulated: a browser folder has no directory to reveal.
 */

import type { epicenterDefinition } from '@epicenter/ai/connection-table';
import type {
	ConnectionKind,
	SendRequest,
	SendTarget,
} from '@epicenter/ai/send';
import type { ConnectionKeys } from '@epicenter/ai/ui';
import type {
	Folder,
	FolderDefinition,
	OpenFolderError,
} from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import manifest from '../../../epicenter.app.json';
import type { CaptureDevice, MicrophonePreference } from '../capture.js';
import type { whisperingDefinition } from '../definition.js';
import type { LocalTranscription } from './local-transcription.js';

/**
 * A folder read through Whispering's definition: Whispering's own, whose
 * declaration is that definition, or another folder opened with it as the
 * lens, whose declaration is its own `epicenter.json`.
 */
export type WhisperingFolder = Folder<
	typeof whisperingDefinition,
	FolderDefinition
>;

/** A request's target over a connection; never one of the account's own resources. */
export type ConnectionTarget = Exclude<
	SendTarget,
	{ readonly kind: 'account' }
>;

/** This device's `so.epicenter`, seen through its `connections` table. */
export type ConnectionsFolder = Folder<
	typeof epicenterDefinition,
	FolderDefinition
>;

/**
 * Where Whispering's requests go (ADR-0557): connections are rows of this
 * device's `so.epicenter`, each row's endpoint and key are kept outside it,
 * and a request is sent by the row's kind. The two workspaces differ in
 * where keys are kept and how a request leaves.
 */
export type WorkspaceConnections = {
	/** The kinds a person may add here, in the order the form offers them. */
	readonly kinds: readonly ConnectionKind[];
	/** Where each connection's endpoint and key are kept. */
	readonly keys: ConnectionKeys;
	/** Where an Epicenter connection's sign-in comes from, for the connection form. */
	readonly epicenterNote: string;
	/** What a person should know about where requests leave from. */
	readonly note: string;
	/** Open this device's `so.epicenter`. The workspace closes it. */
	open(): Promise<Result<ConnectionsFolder, string>>;
	/** Where an Epicenter connection sends now, its deployment's `/v1`, or why there is none. */
	epicenterEndpoint(): Promise<Result<string, string>>;
	/**
	 * Send a request over a connection. A refusal, or an answer that never
	 * came back, is its message; nothing is sent again by this.
	 */
	send(
		target: ConnectionTarget,
		request: SendRequest,
	): Promise<Result<Response, { readonly message: string }>>;
};

/**
 * The folder both workspaces open, named by Whispering's app id in
 * `epicenter.app.json`. The browser
 * names its scoped OPFS directory after it; Epicenter hands an installed app
 * its own folder, `<folder root>/<app-id>`, under this scope (ADR-0552).
 */
export const WHISPERING_FOLDER_ID = manifest.id;

/**
 * Why no workspace could be opened. The message is what the person is shown.
 * Neither storage is tried in place of the other: a browser folder that is
 * refused is not replaced by a desktop one, and inside a desktop app nothing
 * that is missing or refuses is replaced by browser storage.
 */
export const WorkspaceError = defineErrors({
	/** This browser's storage refused or could not be opened. */
	BrowserFolder: ({ refusal }: { refusal: OpenFolderError }) => ({
		message:
			refusal.name === 'InsideTauri'
				? 'This window is inside a desktop app. Browser storage is not used inside a desktop app, so there is no folder to open here.'
				: refusal.message,
		refusal,
	}),
	/** The desktop shell refused this window its folder, or the folder could not be opened. */
	DesktopFolder: ({ refusal }: { refusal: OpenFolderError }) => ({
		message: refusal.message,
		refusal,
	}),
});
export type WorkspaceError = InferErrors<typeof WorkspaceError>;

/** Repeatable failures a debug build can arm. No workspace arms them today; tests do. */
export type InjectionState = {
	readonly rowWrites: number;
	readonly audioWrites: number;
	readonly commitsBlocked: boolean;
};

/**
 * One write of a recording into the folder: its row, written when it starts,
 * or its audio file, written when it stops in a browser or from a fixture.
 */
export type RecordingWrite =
	| { readonly step: 'audio'; readonly stem: string; readonly path: string }
	| { readonly step: 'row'; readonly stem: string };

/**
 * Runs one write of a recording. Failure injection puts an armed failure in
 * that write's way and removes it afterward; the write is always the
 * folder's own and so is its answer. In Epicenter the microphone's audio is
 * written as it is captured, so its file is already there when stop runs and
 * an armed audio failure is left unspent.
 */
export type RecordingWriteHook = <T>(
	write: RecordingWrite,
	run: () => Promise<T>,
) => Promise<T>;

export type TerminalResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

/** A shell whose working directory starts in the folder. */
export type WorkspaceTerminal = {
	/** The working directory the next command starts in, as shown in the prompt. */
	readonly cwd: string;
	/** One line under the terminal's title saying what kind of terminal this is. */
	readonly note: string;
	exec(
		command: string,
		options?: { signal?: AbortSignal },
	): Promise<TerminalResult>;
};

export type Workspace = {
	readonly kind: 'native' | 'browser';
	readonly folder: WhisperingFolder;
	/**
	 * The scope `folder` was opened under: `WHISPERING_FOLDER_ID`, or the
	 * folder Epicenter handed the window. A recording is written under it.
	 */
	readonly folderId: string;
	/** Where the files are: an absolute directory, or a description of browser storage. */
	readonly location: string;
	/**
	 * The person's own shell in the folder. Absent: neither Epicenter nor a
	 * browser offers one to Whispering.
	 */
	readonly terminal: WorkspaceTerminal | undefined;
	/** What this session records from. Fixed when the workspace opens. */
	readonly capture: CaptureDevice;
	/** Something the person should know about capture, such as a refused fixture. */
	readonly captureNotice: string | undefined;
	/** Show the folder in the system file manager; a problem is returned as text. Absent where nothing can. */
	readonly reveal: (() => Promise<string | undefined>) | undefined;
	/**
	 * Transcription with Epicenter's local models, which a `local` connection
	 * reaches; absent in a browser, which has none.
	 */
	readonly localTranscription: LocalTranscription | undefined;
	readonly connections: WorkspaceConnections;
	/**
	 * What this device remembers that is neither folder data nor a secret. It
	 * is never written to `kv.json`, so it does not travel with the folder.
	 */
	readonly preferences: {
		/** The saved microphone, or undefined for the system default. Rejects when it cannot be read. */
		microphone(): Promise<MicrophonePreference | undefined>;
		/** Save the choice, or with undefined forget it. A problem is returned as text. */
		setMicrophone(
			microphone: MicrophonePreference | undefined,
		): Promise<string | undefined>;
	};
	/** Whether debug controls are offered. */
	readonly debugControls: boolean;
	/** Failure injection: only tests provide it. */
	readonly injection:
		| {
				state(): Promise<InjectionState>;
				arm(change: Partial<InjectionState>): Promise<InjectionState>;
				readonly aroundRecordingWrite: RecordingWriteHook;
		  }
		| undefined;
	close(): Promise<void>;
};

/**
 * Opens the build's workspace: the desktop leaf in the build Epicenter serves,
 * the browser leaf otherwise (`#platform/workspace` in `package.json`). A
 * refusal is returned as it is; a leaf never opens another storage instead.
 */
export type OpenWorkspace = () => Promise<Result<Workspace, WorkspaceError>>;
