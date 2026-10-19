/**
 * The one boundary between Whispering and where its files live.
 *
 * Inside Epicenter, Whispering reaches an ordinary directory Epicenter's
 * shell grants it, and its connections and local transcription through
 * Epicenter; a browser tab keeps this site's local folder in the browser.
 * Both are the same `Folder` (`@epicenter/folder`): rows read through
 * Whispering's tables, rooted files, change notification, and save status.
 * Everything above this type is the same code for both. Capabilities a
 * storage cannot offer are `undefined` here, not emulated: a browser has no
 * local model.
 */
import type { Folder, OpenFolderError } from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import manifest from '../../../epicenter.app.json';
import type { CaptureDevice, MicrophonePreference } from '../capture.js';
import type {
	ConnectionChange,
	ConnectionDefaults,
	ConnectionsInfo,
	Operation,
} from '../connections.js';
import type { WhisperingTables } from '../definition.js';
import type {
	PreparedTranscription,
	TranscriptionError,
} from '../transcription.js';
import type {
	PreparedTransformation,
	TransformationError,
} from '../transformation.js';
import type { LocalTranscription } from './local-transcription.js';

/** Whispering's folder: its files, read through Whispering's tables. */
export type WhisperingFolder = Folder<WhisperingTables>;

/**
 * Whispering's app id in `epicenter.app.json`. Epicenter registers an
 * installed app's own directory, `<folder root>/<app-id>`, under this ID
 * (ADR-0552), and the desktop workspace opens that directory by it.
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

export type Workspace = {
	readonly kind: 'native' | 'browser';
	readonly folder: WhisperingFolder;
	/**
	 * The ID the folder was opened under: the directory Epicenter registered
	 * for this window, or `WHISPERING_FOLDER_ID` in a browser. The desktop
	 * recorder writes a recording's audio under it.
	 */
	readonly folderId: string;
	/** Where the files are, as the person is told it. */
	readonly location: string;
	/** What this session records from. Fixed when the workspace opens. */
	readonly capture: CaptureDevice;
	/** Something the person should know about capture, such as a refused fixture. */
	readonly captureNotice: string | undefined;
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
	 * Transcription with Epicenter's active local model; absent in a browser,
	 * which has none.
	 */
	readonly localTranscription: LocalTranscription | undefined;
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
	};
	/**
	 * What this device remembers that is neither folder data nor a secret. It
	 * is never written to the folder, so it does not travel with it.
	 */
	readonly preferences: {
		/** The saved microphone, or undefined for the system default. Rejects when it cannot be read. */
		microphone(): Promise<MicrophonePreference | undefined>;
		/** Save the choice, or with undefined forget it. A problem is returned as text. */
		setMicrophone(
			microphone: MicrophonePreference | undefined,
		): Promise<string | undefined>;
	};
	/** Release the folder and everything else the workspace opened. Saves already started finish first. */
	close(): Promise<void>;
};

/**
 * Opens the build's workspace: the desktop leaf in the build Epicenter serves,
 * the browser leaf otherwise (`#platform/workspace` in `package.json`). A
 * refusal is returned as it is; a leaf never opens another storage instead.
 */
export type OpenWorkspace = () => Promise<Result<Workspace, WorkspaceError>>;
