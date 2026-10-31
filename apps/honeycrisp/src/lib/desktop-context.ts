/**
 * What the desktop app's page knows of its folder, for the header: where it
 * is, whether Epicenter syncs it, and the two things the person can do about
 * either. Only the desktop root (`src/desktop`) sets it, from
 * `desktop-folder.svelte.ts`; this module is types and the context alone, so
 * the web build, which reads it nowhere, carries no desktop code.
 */
import { createContext } from 'svelte';

/** What a "Sync with Epicenter" request came to, as far as the page can know. */
export type SyncRequest = { tone: 'requested' | 'failed'; message: string };

export type DesktopFolder = {
	/** The folder's full path, once the shell said. */
	readonly location: string | undefined;
	/** Whether Epicenter syncs the folder; `undefined` until known. */
	readonly synced: boolean | undefined;
	/** The latest "Sync with Epicenter" request's outcome. */
	readonly request: SyncRequest | undefined;
	/** Ask Epicenter to sync the folder (`syncWithEpicenter`). */
	syncWithEpicenter(): Promise<void>;
	/** Keep the files in another folder: a native picker, then a new window. */
	chooseFolder(): Promise<void>;
};

export const [getDesktopFolder, setDesktopFolder] =
	createContext<DesktopFolder>();
