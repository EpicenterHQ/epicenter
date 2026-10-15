/**
 * The seam between the notes UI and where its folder lives.
 *
 * `#platform/notes-host` resolves at build time. The Epicenter host leaf opens
 * the folder Epicenter hands the installed app's window, a real directory;
 * the browser leaf opens a folder in OPFS. The UI never asks which one it has
 * except through the optional capabilities below, which neither leaf gives
 * today.
 */
import { APPS } from '@epicenter/constants/apps';
import type { Folder, FolderDefinition } from '@epicenter/folder';
import type { honeycrispDefinition } from '../data.js';

type Definition = typeof honeycrispDefinition;

/**
 * Honeycrisp's own folder. The browser names its scoped OPFS directory after
 * it and opens no other; Epicenter registers its own directory under it and
 * hands it to a window opened without a folder.
 */
export const HONEYCRISP_FOLDER_ID = APPS.HONEYCRISP.id;

/**
 * The folder the notes UI uses, whole: `folderOptions` reads and writes it
 * through the query cache, and its change channel reports what changed
 * outside the page. The app never syncs; remotes are outside it. Its own
 * `definition` is `honeycrispDefinition` for Honeycrisp's own folder, and the
 * folder's declaration for any other folder Epicenter hands it, opened with
 * Honeycrisp's shape as the lens.
 */
export type NotesFolder = Folder<Definition, FolderDefinition>;

export type TerminalRun = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

/** A shell whose working directory is the notes folder. */
export type NotesTerminal = {
	/** The working directory the next command starts in, as shown in the prompt. */
	readonly cwd: string;
	/** One line describing what the shell is, for the terminal's header. */
	readonly description: string;
	exec(command: string): Promise<TerminalRun>;
};

/** One commit that changed a file. */
export type FileRevision = {
	readonly oid: string;
	readonly subject: string;
	/** Seconds since the epoch. */
	readonly timestamp: number;
};

export type NotesHost = {
	readonly folder: NotesFolder;
	/** A shell in the notes directory; no leaf gives one today. */
	readonly terminal: NotesTerminal | undefined;
	/** Where the notes are, in words a person can act on: a path, or the browser. */
	readonly location: string;
	/** Open the notes directory in the system file manager; no leaf gives one today. */
	readonly reveal: (() => Promise<string | undefined>) | undefined;
	/** Per-file Git history; no leaf gives it today. */
	readonly history:
		| {
				log(path: string, depth: number): Promise<FileRevision[]>;
				show(oid: string, path: string): Promise<string>;
		  }
		| undefined;
	close(): Promise<void>;
};

/** Open the notes: acquire the folder, then build the notes state over it. */
export type OpenNotes = <TNotes>(options: {
	/** Build the notes state over the opened folder. */
	create(host: NotesHost): Promise<TNotes>;
}) => Promise<TNotes>;
