/**
 * The seam between the notes UI and where its folder lives.
 *
 * `#platform/notes-host` resolves at build time. The desktop leaf opens the
 * folder the desktop shell owns and uses the shell's own commands, including
 * its real `/bin/sh`; the browser leaf opens a folder in OPFS with the
 * folder's emulated shell. The UI never asks which one it has except through
 * the optional capabilities below.
 */
import { APPS } from '@epicenter/constants/apps';
import type { Folder } from '@epicenter/folder';
import type { honeycrispDefinition } from '../data.js';

type Definition = typeof honeycrispDefinition;

/**
 * The folder both leaves open. The browser names its scoped OPFS directory after
 * it; the desktop shell registers its directory under it (`SCOPE` in
 * `src-tauri/src/root.rs`).
 */
export const HONEYCRISP_FOLDER_ID = APPS.HONEYCRISP.id;

/**
 * The folder the notes UI uses, whole: `folderOptions` reads and writes it
 * through the query cache, and its change channel reports what changed
 * outside the page. The app never syncs; remotes are outside it.
 */
export type NotesFolder = Folder<Definition>;

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
	/** The person's own shell in the notes directory; absent in a browser. */
	readonly terminal: NotesTerminal | undefined;
	/** Where the notes are, in words a person can act on: a path, or the browser. */
	readonly location: string;
	/** Open the notes directory in the system file manager; absent in a browser. */
	readonly reveal: (() => Promise<string | undefined>) | undefined;
	/** Per-file Git history; absent where the folder cannot list it by path. */
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
