/**
 * The app's data folder in a Tauri window: the `Data` root the shell named
 * at startup from the app's bundle identifier (ADR-0752). Opening it brings
 * its root `AGENTS.md` up to date with the site's contract (ADR-0772).
 * `home()` loads this module when the folder opens, so a browser never
 * loads it.
 */
import type { Contract } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import { refreshAgentsNote } from './desktop-folder.js';
import type { Store } from './device/store.js';
import type { OpenFolderError } from './errors.js';
import { openRoot } from './native/root.js';

export { revealRoot } from './tauri.js';

/**
 * Open the data folder as a store, with the path the shell answered for it
 * (to show a person; no command takes it). With a `site`, its `AGENTS.md`
 * links the contract that site publishes.
 */
export async function openDataFolder(
	contract: Contract,
	site: string | undefined,
): Promise<Result<{ store: Store; path: string }, OpenFolderError>> {
	const opened = await openRoot('Data');
	if (opened.error !== null) return opened;
	if (site !== undefined)
		await refreshAgentsNote(
			opened.data.store,
			contract,
			`${site}/contract.json`,
		);
	return Ok(opened.data);
}
