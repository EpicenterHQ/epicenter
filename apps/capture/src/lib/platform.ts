/**
 * What Capture's `#platform/*` seams (`package.json` "imports") promise
 * every build. The build picks the leaf: the browser's by default, the
 * desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape;
 * `#platform/device` is `openDevice(capture)` in both, so its type is the
 * client's own.
 */

/** Whether Epicenter syncs the desktop window's folder, as far as the window can tell. */
export type FolderSync = 'synced' | 'not-synced' | 'unknown';

/** What became of a request the desktop shell answers: done, or why not. */
export type FolderRequest = { ok: true } | { ok: false; message: string };

/**
 * `#platform/folder`: the desktop window's folder, which Capture owns
 * (decision 81), or null in a browser.
 */
export type DesktopFolder = {
	/** Asks again each call: Epicenter may set the folder up while Capture is open. */
	synced(): Promise<FolderSync>;
	/**
	 * "Sync with Epicenter": ask the computer to open Epicenter with a request
	 * to sync this folder (`epicenter://init`). Ok means the request was
	 * made, not that Epicenter set anything up.
	 */
	syncWithEpicenter(): Promise<FolderRequest>;
	/**
	 * "Choose folder…": pick another folder; Capture moves there, in a new
	 * window, and the old one closes. Wait for saves before asking. Resolves
	 * `{ ok: true }` without moving when the person cancels.
	 */
	chooseFolder(): Promise<FolderRequest>;
};
