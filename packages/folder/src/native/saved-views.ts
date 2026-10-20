/** Saved-view changes stay in the calling window's already-bound directory. */
import { hostStorage } from '../boundary.js';
import { changeSavedView, type SavedViewChange } from '../declaration-write.js';
import { tauriHostFiles } from '../tauri-files.js';

/** Save one view without opening another handle or naming a native directory. */
export function updateSavedView(change: SavedViewChange) {
	return changeSavedView(hostStorage(tauriHostFiles()), change);
}
