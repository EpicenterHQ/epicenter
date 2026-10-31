/**
 * What Capture's `#platform/*` seams (`package.json` "imports") promise
 * every build. The build picks the leaf: the browser's by default, the
 * desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape;
 * `#platform/device` is `openDevice(capture, …)` in both, so its type is the
 * client's own (null in the window until the person chooses a folder).
 */

/** Whether Epicenter syncs the desktop window's folder, as far as the window can tell. */
export type FolderSync = 'synced' | 'not-synced' | 'unknown';

/** What became of a request the desktop shell answers: done, or why not. */
export type FolderRequest = { ok: true } | { ok: false; message: string };

/** Where the person can keep Capture's files: the two offered folders, or one they pick. */
export type FolderPlace = 'epicenter' | 'app-data' | 'pick';

/**
 * `#platform/folder`: the desktop window's folder, which Capture owns
 * (decisions 81 and 82), or null in a browser.
 */
export type DesktopFolder = {
	/** Where Capture keeps its files, or null until the person chooses. */
	readonly path: string | null;
	/** Why the folder remembered in `settings.md` was not opened, if it was not. */
	readonly problem: string | null;
	/** The two folders offered on first run. */
	readonly places: { readonly epicenter: string; readonly appData: string };
	/**
	 * Recording `path` in `settings.md`, which the window does once it opens
	 * on a folder the person chose, so the next launch opens it again.
	 */
	readonly remembered: Promise<FolderRequest>;
	/** Asks again each call: Epicenter may set the folder up while Capture is open. */
	synced(): Promise<FolderSync>;
	/**
	 * "Sync with Epicenter": ask the computer to open Epicenter with a request
	 * to sync this folder (`epicenter://init`). Ok means the request was
	 * made, not that Epicenter set anything up.
	 */
	syncWithEpicenter(): Promise<FolderRequest>;
	/**
	 * Keep Capture's files at `place`: the shell admits it (or says why not),
	 * and Capture moves there in a new window as the old one closes. Wait
	 * for saves before asking. Ok without moving when the person cancels.
	 */
	choose(place: FolderPlace): Promise<FolderRequest>;
};
