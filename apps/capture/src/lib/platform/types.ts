/**
 * The seam between the Capture UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf attaches
 * to a real directory the desktop shell owns and hears the host's flush
 * before it quits or restarts; the browser leaf opens a logical folder in
 * OPFS and has no host. Neither leaf imports the other's storage.
 */

import type { CaptureFields } from '@epicenter/capture';
import type { HostCloseSignal } from '@epicenter/svelte/flush-on-close';
import type {
	FileTable,
	FolderFiles,
	FolderGit,
	FolderLocation,
} from '@epicenter/folder';

/**
 * The folder both leaves open. The browser names its scoped OPFS directory after
 * it; the desktop shell registers its directory under it.
 */
export const CAPTURE_FOLDER_ID = 'so.epicenter.capture';

/** The folder surface Capture uses. */
export type CaptureFolder = {
	readonly tables: { readonly captures: FileTable<CaptureFields> };
	/** A capture's exact text for repair, and the legacy import's files. */
	readonly files: FolderFiles;
	readonly git: Pick<FolderGit, 'snapshot' | 'subscribe' | 'commit'>;
};

export type CaptureHost = {
	readonly folder: CaptureFolder;
	/** Where the folder says its files are. For showing; never joined onto. */
	readonly location: FolderLocation;
	/**
	 * Let go of this page's use of the folder after the collection has finished
	 * its intended saves. Calls that reach storage after this are refused.
	 * On the desktop the folder stays open for the shell and its other windows.
	 */
	close(): Promise<void>;
};

export type OpenCaptureHost = () => Promise<CaptureHost>;

/**
 * What the desktop host tells this window: its flush before it quits or
 * restarts, and that the Bun service which served the page stopped. Neither
 * exists in a browser.
 */
export type HostSignals = {
	readonly close?: HostCloseSignal;
	readonly stopped?: (listener: () => void) => Promise<() => void>;
};
