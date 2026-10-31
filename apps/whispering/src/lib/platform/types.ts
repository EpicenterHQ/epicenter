/**
 * What a build of Whispering decides, through its `#platform/*` seams
 * (`package.json` "imports"): the local web app's leaves by default, the
 * desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape.
 *
 * - `#platform/root` (`Platform`): which store the pages run over, and the
 *   few components that speak of it.
 * - `#platform/variant` (`Variant`): which build this is, where only a
 *   sentence differs.
 * - `#platform/services` (`CreateServices`): capture, inference,
 *   connections, and preferences, which own no files.
 * - `#platform/auth` (`PlatformAuth`): the optional sign-in with Epicenter.
 */
import type { AuthClient } from '@epicenter/auth';
import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
import type { Client } from '@epicenter/definition/contract';
import type { Component, Snippet } from 'svelte';
import type { Result } from 'wellcrafted/result';
import type { AnyCaptureDevice } from '../capture.js';
import type {
	ConnectionChange,
	ConnectionDefaults,
	ConnectionsInfo,
	Operation,
} from '../connections.js';
import type { Whispering } from '../contract.js';
import type { MicrophonePreferences } from '../microphone-preference.js';
import type {
	PreparedTranscription,
	TranscriptionError,
} from '../transcription.js';
import type {
	PreparedTransformation,
	TransformationError,
} from '../transformation.js';

/**
 * Which Whispering this build is: the local web app over this browser's
 * storage, or the desktop app over its data folder (decision 77).
 */
export type Variant = 'local' | 'desktop';

/**
 * `#platform/root`: the one thing a variant decides (decision 78).
 * `Startup` opens the store and renders the app over it (`children`, given
 * the store's client), or says why it could not: this browser's storage on
 * the web; on the desktop the AppData root and then the data folder, or the
 * recovery screen. `Chrome` is the header's account of the store (where the
 * recordings are, and on the desktop whether Epicenter syncs them). `Settings`
 * is what only this build's settings have, above the connections, or null.
 * `Callback` is the page that ends a sign-in, which only the web app makes.
 */
export type Platform = {
	Startup: Component<{ children: Snippet<[Client<Whispering>]> }>;
	Chrome: Component<ChromeProps>;
	Settings: Component | null;
	Callback: Component<CallbackProps>;
};

/** What the header tells `Chrome`: answers whose result could not be kept, which outrank where the recordings are. */
export type ChromeProps = { unwrittenAnswers: number };

/** What the sign-in callback's page is given: where the app starts. */
export type CallbackProps = { home: string };

/** This page's sign-in with Epicenter, as Svelte state. */
export type PlatformAuth = ReactiveAuthClient<AuthClient>;

export type WhisperingServices = {
	/**
	 * What this app records from, and how: a browser answers the audio at
	 * Stop, the desktop writes it into the data folder from the first
	 * sample. Fixed when the services are constructed.
	 */
	readonly capture: AnyCaptureDevice;
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
		/**
		 * Transcribe on this computer with the active local model. Only the
		 * desktop app has it.
		 */
		useLocal?(operation: Operation): Promise<Result<ConnectionsInfo, string>>;
	};
	/**
	 * What this device remembers that is neither a file nor a secret. It is
	 * never written to Whispering's files, so it does not travel with them.
	 */
	readonly preferences: MicrophonePreferences;
};

/**
 * Construct the capabilities this build offers over `client`, the store the
 * app keeps its files in, without I/O. The desktop records into and
 * transcribes from the folder `client` opened; a browser needs nothing of it.
 */
export type CreateServices = (client: Client<Whispering>) => WhisperingServices;
