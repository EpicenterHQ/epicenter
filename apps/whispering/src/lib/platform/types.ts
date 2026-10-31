/**
 * What this build offers beside Whispering's files: capture, inference,
 * connections, and preferences. These services own no files.
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
import type { MicrophonePreferences } from '../microphone-preference.js';
import type {
	PreparedTranscription,
	TranscriptionError,
} from '../transcription.js';
import type {
	PreparedTransformation,
	TransformationError,
} from '../transformation.js';

/** This page's sign-in with Epicenter, as Svelte state. */
export type PlatformAuth = ReactiveAuthClient<AuthClient>;

export type WhisperingServices = {
	/** What this app records from. Fixed when the services are constructed. */
	readonly capture: CaptureDevice;
	/**
	 * Send a recording's audio over the transcription connection, only while
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
	 * This device's two connections. Kept outside Whispering's files; what the
	 * page is told never includes a key.
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
		/** Send an operation through the signed-in Epicenter account. */
		useAccount(operation: Operation): Promise<Result<ConnectionsInfo, string>>;
		/** Leave the account route to configure a custom endpoint. */
		useCustom(operation: Operation): Promise<Result<ConnectionsInfo, string>>;
	};
	/**
	 * What this device remembers that is neither a file nor a secret. It is
	 * never written to Whispering's files, so it does not travel with them.
	 */
	readonly preferences: MicrophonePreferences;
};

/** Construct the capabilities this build offers, without I/O. */
export type CreateServices = () => WhisperingServices;
