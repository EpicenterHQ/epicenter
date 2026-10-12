/**
 * The one boundary between Whispering and where its files live.
 *
 * The desktop app reaches a real directory through the desktop shell's folder
 * owner, and its other native abilities through the Whispering host; a
 * browser tab keeps a logical folder in OPFS. Everything above this type
 * is the same code for both. Capabilities a storage cannot offer are
 * `undefined` here, not emulated: a browser folder has no directory to reveal.
 */
import type {
	FolderAccess,
	FolderTerminal,
	OpenFolderError,
} from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { CaptureDevice, MicrophonePreference } from '../capture.js';
import type {
	ConnectionChange,
	ConnectionDefaults,
	ConnectionsInfo,
	LegacyKeyTargets,
	Operation,
} from '../connections.js';
import type { whisperingDefinition } from '../definition.js';
import type {
	PreparedTranscription,
	TranscriptionError,
} from '../transcription.js';
import type {
	PreparedTransformation,
	TransformationError,
} from '../transformation.js';

export type WhisperingFolder = FolderAccess<typeof whisperingDefinition>;

/**
 * The folder both workspaces open. The browser names its scoped OPFS directory
 * after it; the desktop shell registers its directory under it
 * (`FOLDER_SCOPE` in `src-tauri/src/lib.rs`).
 */
export const WHISPERING_FOLDER_ID = 'so.epicenter.whispering';

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
	/**
	 * The page is inside a desktop app that did not start the Whispering host,
	 * so it has no terminal or transcription. Nothing is
	 * opened: a folder alone is not the app.
	 */
	HostMissing: () => ({
		message:
			'This window is inside a desktop app that did not start Whispering’s own host, so Whispering cannot run here. Nothing was opened, and browser storage is not used inside a desktop app.',
	}),
	/** The Whispering host did not answer when the window opened. */
	HostUnreachable: ({ reason }: { reason: string }) => ({
		message: `Whispering’s host could not be reached, so the folder was not opened: ${reason}`,
		reason,
	}),
	/** The desktop shell's folder owner refused this window. */
	DesktopFolder: ({ refusal }: { refusal: OpenFolderError }) => ({
		message: refusal.message,
		refusal,
	}),
	/**
	 * The shell's owner and the host name different directories, so audio
	 * would be read and commands run somewhere other than where files are
	 * saved.
	 */
	FolderMismatch: ({ folder, host }: { folder: string; host: string }) => ({
		message: `The desktop app opened the folder at ${folder}, but Whispering’s host uses ${host}. Nothing was opened.`,
		folder,
		host,
	}),
});
export type WorkspaceError = InferErrors<typeof WorkspaceError>;

/** Repeatable failures a debug desktop shell can arm. */
export type InjectionState = {
	readonly rowWrites: number;
	readonly audioWrites: number;
	readonly commitsBlocked: boolean;
};

/** One write of a recording's publication: its audio file, or its row. */
export type RecordingWrite =
	| { readonly step: 'audio'; readonly stem: string; readonly path: string }
	| { readonly step: 'row'; readonly stem: string };

/**
 * Runs one write of a recording's publication. A debug desktop shell puts an
 * armed failure in that write's way and removes it afterward; the write is
 * always the folder's own and so is its answer.
 */
export type RecordingWriteHook = <T>(
	write: RecordingWrite,
	run: () => Promise<T>,
) => Promise<T>;

export type Workspace = {
	readonly kind: 'native' | 'browser';
	readonly folder: WhisperingFolder;
	/** Where the files are: an absolute directory, or a description of browser storage. */
	readonly location: string;
	readonly terminal: FolderTerminal;
	/** One line under the terminal's title saying what kind of terminal this is. */
	readonly terminalNote: string;
	/** What this session records from. Fixed when the workspace opens. */
	readonly capture: CaptureDevice;
	/** Something the person should know about capture, such as a refused fixture. */
	readonly captureNotice: string | undefined;
	/** Show the folder in the system file manager; a problem is returned as text. */
	readonly reveal: (() => Promise<string | undefined>) | undefined;
	/**
	 * Send the audio a row names over the transcription connection, only while
	 * that connection is still the base URL the request was prepared for.
	 * Nothing is written by this.
	 */
	transcribe(
		request: PreparedTranscription,
	): Promise<Result<{ text: string }, TranscriptionError>>;
	/**
	 * Send instructions and a text to the text connection's chat endpoint and
	 * return its answer, only while that connection is still the base URL the
	 * request was prepared for. Nothing is written by this.
	 */
	transform(
		request: PreparedTransformation,
	): Promise<Result<{ text: string }, TransformationError>>;
	/** Where text requests leave from, and what that requires of the endpoint. */
	readonly transformNote: string;
	/**
	 * This device's two connections. Kept outside the folder; what the page is
	 * told never includes a key.
	 */
	readonly connections: {
		/** Where connections and keys are kept, for the settings form. */
		readonly storedIn: string;
		/** Where an unconfigured connection's form starts. Never used for a request. */
		readonly defaults: ConnectionDefaults;
		/** Rejects when what is stored cannot be read. */
		read(): Promise<ConnectionsInfo>;
		/** Save one connection; a refusal is returned as text. */
		set(
			operation: Operation,
			change: ConnectionChange,
		): Promise<Result<ConnectionsInfo, string>>;
		/** Move the earlier build's key into the chosen connections; a refusal is returned as text. */
		adoptLegacyKey(
			targets: LegacyKeyTargets,
		): Promise<Result<ConnectionsInfo, string>>;
	};
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
	/** Failure injection, in a debug desktop shell only. */
	readonly injection:
		| {
				state(): Promise<InjectionState>;
				arm(change: Partial<InjectionState>): Promise<InjectionState>;
				readonly aroundRecordingWrite: RecordingWriteHook;
		  }
		| undefined;
	close(): Promise<void>;
};
