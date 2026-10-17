/**
 * The one boundary between Whispering and where its files live.
 *
 * Inside Epicenter, Whispering reaches a real directory Epicenter's shell
 * grants it, and its connections and local transcription through Epicenter;
 * a browser tab keeps a logical folder in OPFS. Everything above this type
 * is the same code for both. Capabilities a storage cannot offer are
 * `undefined` here, not emulated: a browser has no local model.
 */
import type { Definition, Folder, OpenFolderError } from '@epicenter/folder';
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
import type { whisperingDefinition } from '../definition.js';
import type {
	PreparedTranscription,
	TranscriptionError,
} from '../transcription.js';
import type {
	PreparedTransformation,
	TransformationError,
} from '../transformation.js';
import type { LocalTranscription } from './local-transcription.js';

/**
 * A folder read through Whispering's definition: Whispering's own, whose
 * declaration is that definition, or another folder read through it, whose
 * declaration is its own `epicenter.json`.
 */
export type WhisperingFolder = Folder<typeof whisperingDefinition, Definition>;

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
	close(): Promise<void>;
};

/**
 * Opens the build's workspace: the desktop leaf in the build Epicenter serves,
 * the browser leaf otherwise (`#platform/workspace` in `package.json`). A
 * refusal is returned as it is; a leaf never opens another storage instead.
 */
export type OpenWorkspace = () => Promise<Result<Workspace, WorkspaceError>>;
