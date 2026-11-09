/**
 * This computer's settings for this app, as one store the page connects to
 * once (ADR-0778): model choices, the connections list, the account's
 * identity on the desktop, a shortcut, a microphone, local speech. Each
 * capability names the files it keeps (`settings.file(name)`) when it is
 * made; the page connects to all of them at once, and then every read is
 * synchronous. `<WhenOpen>` waits for the connection, so nothing that reads
 * a setting renders before it.
 *
 * | Build | The place |
 * | --- | --- |
 * | desktop (`tauri`) | the top of the app's AppData root; the shell is its only writer, and its watcher tells every window |
 * | web (`default`) | this browser's `localStorage` for the site |
 * | `test` | memory, empty at first |
 *
 * A write replaces the file: no version is read or checked, since every
 * write goes through one writer (the shell on the desktop, the page's own
 * synchronous storage on the web). A file that does not read is the
 * capability's to say, by a typed error naming it; it never holds up the
 * connection, and saving a new value replaces it.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

export const SettingsError = defineErrors({
	/** This computer's settings could not be reached: the shell refused, or the browser keeps no storage. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: `The settings on this computer could not be reached: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SettingsError = InferErrors<typeof SettingsError>;

/**
 * A read of a setting before the page connected to this computer's
 * settings: a mistake in the code that made it, since nothing that reads
 * one renders before `<WhenOpen>`.
 */
export class SettingsNotOpen extends Error {
	override readonly name = 'SettingsNotOpen';
	constructor(file: string) {
		super(
			`The setting ${file} was read before this computer's settings connected: read it inside <WhenOpen>, or await an action`,
		);
	}
}

/** Where the settings are in their life. Only the failed state carries `retry()`. */
export type SettingsState =
	| { readonly status: 'opening' }
	| { readonly status: 'open' }
	| {
			readonly status: 'failed';
			readonly error: SettingsError;
			retry(): Promise<void>;
	  };

/** One settings file: its text, read at once, and a write that replaces it. */
export type SettingsFile = {
	readonly name: string;
	/** The file's text, or null when there is none. Throws `SettingsNotOpen` before the settings connected. */
	text(): string | null;
	/**
	 * Replace the file with `text`, or remove it for null, answering once it
	 * landed; waits for the connection. Rejects with `SettingsError` when the
	 * place cannot take it.
	 */
	write(text: string | null): Promise<void>;
	/** Answers once the settings connected, or rejects with why they could not. */
	connected(): Promise<void>;
	/** Call `listener` when `text()` may answer differently; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
};

/** This computer's settings: their connection, and each file a capability keeps. */
export type Settings = {
	state(): SettingsState;
	/** Call `listener` when `state()` or any file changes; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** The file `name` at the top of this app's place for settings, kept from now on. */
	file(name: string): SettingsFile;
};

/** What a build gives the settings: one place's files, by name. */
export type SettingsPlace = {
	/** Start hearing changes; answers the stop once listening. Throws when the place cannot be reached. */
	watch(changed: (names: readonly string[] | 'all') => void): Promise<() => void>;
	/** The file's text, or null when there is none. Throws when the place cannot be reached. */
	read(name: string): Promise<string | null>;
	/** Replace the file, or remove it for null. Throws when the place cannot take it. */
	write(name: string, text: string | null): Promise<void>;
};

/** The settings over `place`, connecting a turn after the first file is named. */
export function createSettings(place: SettingsPlace): Settings {
	const texts = new Map<string, string | null>();
	const names = new Set<string>();
	const listeners = new Set<() => void>();
	const fileListeners = new Map<string, Set<() => void>>();
	let state: SettingsState = { status: 'opening' };
	let connected = false;
	let connecting: Promise<void> | null = null;
	let waiting = Promise.withResolvers<void>();
	/** Names heard changing while the connection read them. */
	let heard: Set<string> | 'all' = new Set();

	function notify(name?: string) {
		for (const listener of [...(name ? (fileListeners.get(name) ?? []) : [])])
			listener();
		for (const listener of [...listeners]) listener();
	}

	function hold(name: string, text: string | null) {
		if (texts.has(name) && texts.get(name) === text) return;
		texts.set(name, text);
		notify(name);
	}

	async function reread(which: readonly string[]) {
		for (const name of which) {
			try {
				hold(name, await place.read(name));
			} catch {
				// The next change heard reads it again.
			}
		}
	}

	function hear(changed: readonly string[] | 'all') {
		if (!connected) {
			if (changed === 'all') heard = 'all';
			else if (heard !== 'all') for (const name of changed) heard.add(name);
			return;
		}
		void reread(
			changed === 'all' ? [...names] : changed.filter((name) => names.has(name)),
		);
	}

	async function connect() {
		try {
			await place.watch(hear);
			const read = await Promise.all(
				[...names].map(async (name) => [name, await place.read(name)] as const),
			);
			for (const [name, text] of read) texts.set(name, text);
			connected = true;
			state = { status: 'open' };
			waiting.resolve();
			notify();
			const again = heard === 'all' ? [...names] : [...heard];
			heard = new Set();
			await reread(again);
		} catch (cause) {
			const error = SettingsError.Unavailable({ cause }).error;
			const failed = waiting;
			waiting = Promise.withResolvers<void>();
			failed.reject(error);
			// A waiting action hears the failure; nothing else must.
			failed.promise.catch(() => {});
			const retry = async () => {
				if (state.status !== 'failed' || state.retry !== retry) return;
				state = { status: 'opening' };
				notify();
				connecting = connect();
				await connecting;
			};
			state = { status: 'failed', error, retry };
			notify();
		}
	}

	function start() {
		connecting ??= Promise.resolve().then(connect);
	}

	function file(name: string): SettingsFile {
		if (!names.has(name)) {
			names.add(name);
			// Named after the connection: read it now, as a change heard.
			if (connected) void reread([name]);
		}
		start();
		return {
			name,
			text() {
				if (!connected) throw new SettingsNotOpen(name);
				return texts.get(name) ?? null;
			},
			async write(text) {
				await waiting.promise;
				try {
					await place.write(name, text);
				} catch (cause) {
					throw SettingsError.Unavailable({ cause }).error;
				}
				hold(name, text);
			},
			connected: () => waiting.promise,
			subscribe(listener) {
				let own = fileListeners.get(name);
				if (own === undefined) {
					own = new Set();
					fileListeners.set(name, own);
				}
				const set = own;
				set.add(listener);
				return () => {
					set.delete(listener);
				};
			},
		};
	}

	return {
		state: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		file,
	};
}
