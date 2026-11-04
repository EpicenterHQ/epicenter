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
 * - `#platform/services` (`CreateServices`): capture, the endpoints models
 *   are reached at, and preferences, which own no files.
 * - `#platform/auth` (`PlatformAuth`): the optional sign-in with Epicenter.
 */
import type { AuthClient } from '@epicenter/account';
import type { ReactiveAuthClient } from '@epicenter/account/svelte';
import type { Endpoint } from '@epicenter/ai';
import type { ModelChoices } from '@epicenter/ai/choices';
import type { AiConnections } from '@epicenter/ai/connections';
import type { Client } from '@epicenter/definition/contract';
import type { ReactiveClient } from '@epicenter/svelte/client';
import type { Component, Snippet } from 'svelte';
import type { CaptureDevice } from '../capture.js';
import type { Whispering } from '../contract.js';
import type { MicrophonePreferences } from '../microphone-preference.js';

/**
 * Which Whispering this build is: the local web app over this browser's
 * storage, or the desktop app over its data folder (decision 77).
 */
export type Variant = 'local' | 'desktop';

/**
 * `#platform/root`: the one thing a variant decides (decision 78).
 * `Startup` opens the store and renders the app over it (`children`, given
 * the store's client and that client wrapped once for Svelte, where it was
 * made: decision 87), or says why it could not: this browser's storage on
 * the web; on the desktop the AppData root and then the data folder, or the
 * recovery screen. `Chrome` is the header's account of the store (where the
 * recordings are, and on the desktop whether Epicenter syncs them). `Settings`
 * is what only this build's settings have, above the models, or null.
 * `Callback` is the page that ends a sign-in, which only the web app makes.
 */
export type Platform = {
	Startup: Component<{
		children: Snippet<[Client<Whispering>, ReactiveClient<Whispering>]>;
	}>;
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
	 * What this app records from, writing each recording into the store as
	 * it records: the desktop Opus in WebM in the data folder from the first sample,
	 * a browser each piece into this browser's files. Fixed when the services
	 * are constructed.
	 */
	readonly capture: CaptureDevice;
	/** Where this build's models are, besides the person's saved connections. */
	readonly endpoints: WhisperingEndpoints;
	/**
	 * What this device remembers that is neither a file nor a secret. It is
	 * never written to Whispering's files, so it does not travel with them.
	 */
	readonly preferences: MicrophonePreferences;
};

/**
 * The endpoints this build merges (ADR-0757), in the order the model picker
 * lists them: Epicenter's hosted models, the person's saved connections,
 * then what runs on this computer. Nothing here sends a request until the
 * person asks, and a probe of this computer runs only while a picker shows.
 */
export type WhisperingEndpoints = {
	/**
	 * Epicenter's hosted models through the account signed in now. Read again,
	 * it follows sign-in and sign-out; read in Svelte, it tracks them.
	 */
	hosted(): Endpoint;
	/** Ollama and LM Studio, and on the desktop transcription in this app (`localSpeech`). */
	readonly local: readonly Endpoint[];
	/**
	 * Open the person's saved connections, each a provider's base URL and its
	 * key: this site's storage on the web, AppData's `connections.md` with each
	 * key in the credential store on the desktop. Rejects when they cannot be
	 * opened.
	 */
	openConnections(): Promise<AiConnections>;
	/** Open this device's model choice for transcription and for text, kept beside the microphone's. */
	openChoices(): ModelChoices;
	/** Where a saved connection's key is kept, and where its requests leave from. */
	readonly note: string;
};

/**
 * Construct the capabilities this build offers over `client`, the store the
 * app keeps its files in, without I/O. Both builds record into `client`.
 */
export type CreateServices = (client: Client<Whispering>) => WhisperingServices;
