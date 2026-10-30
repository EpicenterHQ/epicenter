/**
 * What this build offers beside the folder OpenFolder opened: capture,
 * inference, connections, preferences, and recording recovery. These services
 * own no folder lifetime. Unsupported capabilities are undefined.
 */
import type { AuthClient } from '@epicenter/auth';
import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
import type { Result } from 'wellcrafted/result';
import type { CaptureDevice } from '../capture.js';
import type {
	ConnectionChange,
	ConnectionDefaults,
	ConnectionsInfo,
	Operation,
} from '../connections.js';
import type { WhisperingFolder } from '../folder.js';
import type { MicrophonePreferences } from '../microphone-preference.js';
import type {
	LocalTranscription,
	PreparedTranscription,
	TranscriptionError,
} from '../transcription.js';
import type {
	PreparedTransformation,
	TransformationError,
} from '../transformation.js';

/** The one auth handle exposed by either build's platform leaf. */
export type PlatformAuth = ReactiveAuthClient<AuthClient> & {
	/** A desktop status-read problem, when the shell reports one. */
	problem?: string;
};

export type WhisperingServices = {
	readonly kind: 'native' | 'browser';
	/** Where the files are, as the person is told it. */
	readonly location: string;
	/** What this app records from. Fixed when the services are constructed. */
	readonly capture: CaptureDevice;
	/** Repair recordings a quit or crash cut off before anything reads them; report when they could not be checked. */
	recoverRecordings(): Promise<string | undefined>;
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
		/** Browser only: select the signed-in Epicenter account for an operation. */
		useAccount?(operation: Operation): Promise<Result<ConnectionsInfo, string>>;
		/** Browser only: leave the account route to configure a custom endpoint. */
		useCustom?(operation: Operation): Promise<Result<ConnectionsInfo, string>>;
	};
	/**
	 * What this device remembers that is neither folder data nor a secret. It
	 * is never written to the folder, so it does not travel with it.
	 */
	readonly preferences: MicrophonePreferences;
};

/** Construct the capabilities this build offers beside the opened folder, without I/O or owning its lifetime. */
export type CreateServices = (folder: WhisperingFolder) => WhisperingServices;
