/**
 * The folder the desktop shell handed an installed app's window.
 *
 * The shell opens an installed app's window with the folder it hands it as
 * `?folder=<scope>` (`open_installed_app`): the app's own folder, named by
 * the app's id, or another folder whose declaration contains the app's shape
 * (ADR-0538). A window handed no folder opens the app's own.
 *
 * The app owns its own folder's schema, so that folder opens with
 * `openFolder`, which publishes the app's definition. Any other folder opens
 * with `openDataFolder` and the definition as the lens: its declaration is
 * never written, and one that does not contain the lens is refused with the
 * app's and the folder's names.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderDefinition } from './definition.js';
import type { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import { openDataFolder, openFolder } from './tauri-adapter.js';

/** The folder a window opened, its scope, and whether it is the app's own. */
export type HandedFolder<TDefinition extends FolderDefinition> = {
	readonly folder: Folder<TDefinition, FolderDefinition>;
	/** The scope the folder opened under. */
	readonly id: string;
	/** Whether the folder is the app's own, `ownId`. */
	readonly own: boolean;
};

/**
 * The scope prefix of a folder the shell lists that is not an app's own:
 * `data:<directory name>`. An app's own folder's scope is its directory, the
 * app's id. The Rust twin builds it in `data_folders.rs`
 * (`apps/epicenter/src-tauri/src/data_folders.rs`, `format!("data:{name}")`).
 */
const DATA_SCOPE_PREFIX = 'data:';

/** The folder's name as a person knows it: its directory's. */
function folderName(id: string): string {
	return id.startsWith(DATA_SCOPE_PREFIX)
		? id.slice(DATA_SCOPE_PREFIX.length)
		: id;
}

/** The scope the shell handed this window as `?folder=`, if any. */
function handedScope(): string | undefined {
	const handed = new URLSearchParams(globalThis.location?.search).get('folder');
	return handed || undefined;
}

/**
 * Open the folder the shell handed this window, or the app's own when it was
 * handed none. Refusals are returned as `openFolder` and `openDataFolder`
 * return them; a `ShapeMismatch` says which app cannot open which folder.
 * Called from a mounted page; importing this module opens nothing.
 */
export async function openHandedFolder<
	const TDefinition extends FolderDefinition,
>({
	ownId,
	definition,
	appTitle,
}: {
	/** The app's own folder's scope, the app's id. */
	readonly ownId: string;
	/** The app's definition: published to its own folder, a lens on any other. */
	readonly definition: TDefinition;
	/** The app's name in a refusal, such as `Todos`. */
	readonly appTitle: string;
}): Promise<Result<HandedFolder<TDefinition>, OpenFolderError>> {
	const id = handedScope() ?? ownId;
	if (id === ownId) {
		const { data: folder, error } = await openFolder({ id, definition });
		if (error !== null) return Err(error);
		return Ok({ folder, id, own: true });
	}
	const { data: folder, error } = await openDataFolder({
		id,
		lens: definition,
	});
	if (error === null) return Ok({ folder, id, own: false });
	if (error.name !== 'ShapeMismatch') return Err(error);
	return Err({
		...error,
		message: `${appTitle} cannot open the folder '${folderName(id)}': ${error.problems.map((problem) => problem.message).join('; ')}.`,
	});
}
