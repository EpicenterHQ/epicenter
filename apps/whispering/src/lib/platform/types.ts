/**
 * What a build of Whispering decides, through its `#platform/*` seams
 * (`package.json` "imports"): the local web app's leaves by default, the
 * desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape.
 *
 * - `#platform/account`: the optional sign-in with Epicenter
 *   (`connectAccount`).
 * - `#platform/computer`: the microphone, the model servers on this
 *   computer, and the global shortcut (`GlobalShortcut`, desktop only),
 *   which `src/lib/app.ts` makes its capabilities with.
 * - `#platform/components` (`Platform`): the few components that speak of
 *   the build's store.
 * - `#platform/variant` (`Variant`): which build this is, where only a
 *   sentence differs.
 */
import type { Component } from 'svelte';

/**
 * Which Whispering this build is: the local web app over this browser's
 * storage, or the desktop app over its data folder (decision 77).
 */
export type Variant = 'local' | 'desktop';

/**
 * `#platform/components`: `Chrome` is the header's account of the store
 * (where the recordings are, and on the desktop whether Epicenter syncs
 * them). `Settings` is what only this build's settings have, above the
 * models, or null. `Callback` is the page that ends a sign-in, which only
 * the web app makes.
 */
export type Platform = {
	Chrome: Component;
	Settings: Component | null;
	Callback: Component<CallbackProps>;
};

/** What the sign-in callback's page is given: where the app starts. */
export type CallbackProps = { home: string };

/**
 * The desktop's global shortcut (`openShortcut` in `shortcut.tauri.ts`):
 * the key `shortcuts.md` resolves to and the shell's hold on it. Reads
 * answer at once; `subscribe` hears them change.
 */
export type GlobalShortcut = {
	/** True once both `shortcuts.md` notes were read (or found absent). */
	read(): boolean;
	/** The resolved key, in the global-shortcut plugin's spelling. */
	accelerator(): string;
	/** The resolved key as a person reads it. */
	label(): string;
	/** Whether this computer's `shortcuts.md` sets the key, overriding the data folder's. */
	onThisComputer(): boolean;
	/** Why the shell does not hold the resolved key, or why this computer's note does not read. */
	problem(): string | null;
	subscribe(listener: () => void): () => void;
	/** Make `typed` the shortcut, in the data folder's note or this computer's; why it was not saved, or null. */
	save(
		typed: string,
		options: { onThisComputer: boolean },
	): Promise<string | null>;
	[Symbol.dispose](): void;
};
