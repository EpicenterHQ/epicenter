/**
 * Opening a folder whose directory is already decided, shared by the browser
 * folder (an OPFS directory its ready marker claims) and the directory folder
 * (a real directory the desktop shell granted).
 *
 * The opener supplies the file storage and the history, whatever orders
 * their changes (Web Locks in the browser, the host's checks and Git's on a
 * directory, ADR-0541), and the host's one detector of changes made outside
 * the handle (ADR-0548).
 */
import { shapeProblems } from '@epicenter/definition';
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { readDeclaration } from './declaration.js';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { OpenFolderError } from './errors.js';
import {
	assembleFolder,
	createFileHints,
	type FilesChanged,
	type Folder,
	type FolderHistory,
	type FolderLocation,
} from './folder.js';
import { withPublication } from './storage.js';

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

/**
 * Whose schema a handle reads with: the opener's prepared definition, which
 * the handle publishes to `epicenter.json` (`openFolder`), or `'declared'`,
 * the folder's own `epicenter.json`, read once the files are reachable and
 * never written (`openDataFolder`).
 */
export type FolderSchema = FolderDefinition | 'declared';

/** What a folder with no `epicenter.json` declares: no tables. */
const UNDECLARED = (() => {
	const { data, error } = prepareFolderDefinition({ tables: {} });
	if (error !== null) throw new Error(error.reason);
	return data;
})();

/**
 * Make the folder's storage, and its history once the definition is known.
 * `relay` hears each landed step, for the detector; `landed` hears the
 * paths an incoming update wrote.
 */
type StartFolder = (wiring: {
	readonly relay: (paths: readonly string[]) => void;
	readonly landed: (paths: readonly string[]) => void;
}) => Promise<{
	readonly boundary: FolderStorage;
	/** The history, whose Sync merges rows by `definition`. */
	readonly history: (definition: FolderDefinition) => FolderHistory;
}>;

export async function openAtRoot<
	TDefinition extends FolderDefinition,
	TDeclared extends FolderDefinition = TDefinition,
>(
	schema: FolderSchema,
	captured: {
		readonly location: FolderLocation;
		readonly start: StartFolder;
		/** The host's detector of outside changes; none in Bun. */
		readonly detector?: ChangeDetector;
		/**
		 * With `'declared'`, the prepared shape the caller reads. The folder's
		 * declaration must contain it (ADR-0538), or nothing opens.
		 */
		readonly lens?: FolderDefinition;
	},
): Promise<Result<Folder<TDefinition, TDeclared>, OpenFolderError>> {
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
		let prepared: FolderDefinition;
		if (schema === 'declared') {
			// Read through the folder's own file boundary, after the grant, as
			// every later read is.
			const { data: declared, error } = await readDeclaration(boundary);
			if (error !== null) {
				release();
				return OpenFolderError.InvalidDeclaration(error);
			}
			prepared = declared ?? UNDECLARED;
			if (captured.lens !== undefined) {
				const problems = shapeProblems(prepared, captured.lens);
				if (problems.length > 0) {
					release();
					return OpenFolderError.ShapeMismatch({ problems });
				}
			}
		} else prepared = schema;
		// A change made once the handle is returned is heard.
		await detected?.ready;
		const opened = started.history(prepared);
		history = opened;
		const folder = assembleFolder<TDefinition, TDeclared>({
			prepared,
			lens: schema === 'declared' ? captured.lens : undefined,
			publishes: schema !== 'declared',
			storage: withPublication({ storage: boundary, history: opened }),
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
