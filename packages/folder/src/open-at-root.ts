/**
 * Opening a folder whose directory is already decided, shared by the browser
 * folder (the OPFS directory its ID names) and the directory folder (a real
 * directory the desktop shell granted, or one a Bun process names).
 *
 * The opener supplies the file storage and the history, whatever orders
 * their changes (Web Locks in the browser, the host's checks and Git's on a
 * directory, ADR-0541), and the host's one detector of changes made outside
 * the handle (ADR-0548).
 */
import { mismatches } from '@epicenter/definition';
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { readDefinition } from './declaration.js';
import type { Definition } from './definition.js';
import { OpenFolderError } from './errors.js';
import {
	assembleFolder,
	createFileHints,
	type FilesChanged,
	type Folder,
	type FolderHistory,
	type FolderLocation,
} from './folder.js';
import type { Opening } from './opening.js';

/**
 * A host's one detector of changes made outside this handle (ADR-0548).
 * Started once the handle can hear; it calls `report` for each change it
 * detects. `relay`, when present, hears each step of this handle's own that
 * landed, for a detector that tells other pages. `stop` ends it at close.
 */
export type ChangeDetector = (report: (change: FilesChanged) => void) => {
	readonly relay?: (paths: readonly string[]) => void;
	readonly stop: () => void;
	/** Settles once the detector hears changes; opening waits for it. */
	readonly ready?: Promise<void>;
};

/** The name a person knows the folder at `location` by: its directory's. */
function folderName(location: FolderLocation): string {
	if (location.kind === 'opfs') return location.directory;
	return location.root.split(/[\\/]/).filter(Boolean).pop() ?? location.root;
}

/**
 * Make the folder's storage, and its history once the definition is read.
 * `relay` hears each landed step, for the detector; `landed` hears the
 * paths an incoming update wrote.
 */
type StartFolder = (wiring: {
	readonly relay: (paths: readonly string[]) => void;
	readonly landed: (paths: readonly string[]) => void;
}) => Promise<{
	readonly boundary: FolderStorage;
	/** Start the history, which reads no definition (ADR-0591, ADR-0592). */
	readonly history: () => FolderHistory;
}>;

/**
 * Open the folder `target` names over the storage `captured.start` makes:
 * with the app's definition in the app's own folder, and with the tables the
 * folder's own schema files declare anywhere else (`readDefinition`), which
 * must contain the definition the folder is read through, if any.
 */
export async function openAtRoot<TDefinition extends Definition>(
	target: Opening,
	captured: {
		readonly location: FolderLocation;
		readonly start: StartFolder;
		/** The host's detector of outside changes; none in Bun. */
		readonly detector?: ChangeDetector;
	},
): Promise<Result<Folder<TDefinition, Definition>, OpenFolderError>> {
	const hints = createFileHints();
	let history: FolderHistory | undefined;
	let detected: ReturnType<ChangeDetector> | undefined;
	const release = () => detected?.stop();
	try {
		// An outside change makes the history's observations stale and tells
		// the listeners. Reports before the history exists, or after it
		// closed, reach nobody: no listener can have subscribed yet, or all
		// are gone.
		detected = captured.detector?.((change) => {
			if (history === undefined || history.snapshot.closed) return;
			history.noteEdit();
			hints.report(change);
		});
		const started = await captured.start({
			relay: (paths) => detected?.relay?.(paths),
			// What this handle's own Sync wrote is a change its listeners did
			// not make, so it is reported like an outside one.
			landed: (paths) => hints.report(paths),
		});
		const { boundary } = started;
		const { definition } = target;
		let prepared: Definition;
		if (target.own) prepared = target.definition;
		else {
			// Read through the folder's own file boundary, after the grant, as
			// every later read is.
			const { data: declared, error } = await readDefinition(boundary);
			if (error !== null) {
				release();
				return OpenFolderError.InvalidDefinition(error);
			}
			prepared = declared;
			if (definition !== undefined) {
				const problems = mismatches(prepared, definition);
				if (problems.length > 0) {
					release();
					return OpenFolderError.DefinitionMismatch({
						// An app is named by its definition's title; a reader
						// that is no app is not named.
						app:
							target.app === undefined
								? undefined
								: (definition.title ?? 'This app'),
						folder: folderName(captured.location),
						problems,
					});
				}
			}
		}
		// A change made once the handle is returned is heard.
		await detected?.ready;
		const opened = started.history();
		history = opened;
		const folder = assembleFolder<TDefinition, Definition>({
			id: target.id,
			own: target.own,
			prepared,
			through: target.own ? undefined : definition,
			storage: boundary,
			history: opened,
			location: captured.location,
			hints,
			release: async () => release(),
		});
		return Ok(folder);
	} catch (cause) {
		release();
		return OpenFolderError.Unavailable({ cause });
	}
}
