/**
 * Opening a folder whose directory is already decided, shared by the browser
 * folder (an OPFS directory its ready marker claims) and the directory folder
 * (a real directory the desktop shell granted).
 *
 * Pages of one origin that open the same folder share it: each landed step is
 * told to the others over a `BroadcastChannel`, and their Web Locks order
 * every change. The opener supplies the file storage and the history.
 */
import { Ok, type Result } from 'wellcrafted/result';
import type { FileBoundary } from './boundary.js';
import { readDeclaration } from './declaration.js';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { OpenFolderError } from './errors.js';
import {
	assembleFolder,
	createFileHints,
	type Folder,
	type FolderLocation,
} from './folder.js';
import type { createHistory } from './git/history.js';
import { callObserver } from './observer.js';
import type { OpfsEnvironment } from './opfs-store.js';
import { withPublication } from './storage.js';

/** One folder's captured address and every name derived from it. */
export type FolderAddress = {
	readonly address: string;
	readonly directory: string;
	/** Held while deciding whether the directory is the folder, and by a download throughout. */
	readonly openLock: string;
	readonly filesLock: string;
	readonly gitLock: string;
	readonly hintChannel: string;
};

/**
 * Whose schema a handle reads with: the opener's prepared definition, which
 * the handle publishes to `epicenter.json` (`openFolder`), or `'declared'`,
 * the folder's own `epicenter.json`, read once the files are reachable and
 * never written (`openDataFolder`).
 */
export type FolderSchema = FolderDefinition | 'declared';

/** What a folder with no `epicenter.json` declares: no tables and no settings. */
const UNDECLARED = (() => {
	const { data, error } = prepareFolderDefinition({ kv: {}, tables: {} });
	if (error !== null) throw new Error(error.reason);
	return data;
})();

/**
 * Make the folder's storage, and its history once the definition is known.
 * `relay` hears each landed step, to tell other pages; `landed` hears the
 * paths an incoming update wrote.
 */
export type StartFolder = (wiring: {
	readonly relay: (paths: readonly string[]) => void;
	readonly landed: (paths: readonly string[]) => void;
}) => Promise<{
	readonly boundary: FileBoundary;
	/** The history, whose Sync merges rows by `definition`. */
	readonly history: (
		definition: FolderDefinition,
	) => ReturnType<typeof createHistory>;
}>;

export async function openAtRoot<TDefinition extends FolderDefinition>(
	schema: FolderSchema,
	environment: Pick<OpfsEnvironment, 'BroadcastChannel'>,
	captured: {
		readonly at: FolderAddress;
		readonly location: FolderLocation;
		readonly start: StartFolder;
	},
): Promise<Result<Folder<TDefinition>, OpenFolderError>> {
	const { at } = captured;
	let channel: BroadcastChannel | undefined;
	let channelOpen = false;
	const release = () => {
		channelOpen = false;
		try {
			channel?.close();
		} catch {
			// A channel that will not close has nothing left to give back.
		}
	};
	try {
		// Other pages of this origin share the directory. Each landed step is
		// told to them as it lands; this handle's own listeners hear a save
		// when it finishes.
		if (environment.BroadcastChannel !== undefined) {
			channel = new environment.BroadcastChannel(at.hintChannel);
			// A runtime that counts an open channel as pending work must not be
			// kept alive by a folder nobody closed.
			(channel as { unref?: () => void }).unref?.();
			channelOpen = true;
		}
		// A relay that fails is another page's missed hint, never this save's
		// failure.
		const relay = (paths: readonly string[]) => {
			if (channelOpen && paths.length > 0)
				callObserver(
					'change relay',
					(landed: readonly string[]) => channel?.postMessage([...landed]),
					paths,
				);
		};
		const hints = createFileHints();
		const started = await captured.start({
			relay,
			landed: (paths) => hints.emit(paths),
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
		} else prepared = schema;
		const history = started.history(prepared);
		if (channel !== undefined) {
			channel.onmessage = ({ data }) => {
				if (!channelOpen || history.snapshot.closed || !Array.isArray(data))
					return;
				history.noteEdit();
				hints.receive(data as string[]);
			};
		}
		const folder = assembleFolder<TDefinition>({
			prepared,
			publishes: schema !== 'declared',
			storage: withPublication({
				storage: boundary,
				history,
				landed: (paths) => hints.emit(paths),
			}),
			history,
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
