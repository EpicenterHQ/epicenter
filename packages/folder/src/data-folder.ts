/**
 * The app's data folder in a Tauri window: the `Data` root the shell named
 * at startup, the directory in the Epicenter folder its shell remembers by
 * identity, or its usual path (ADR-0752, ADR-0822). Its hash cache is kept
 * in the app's own data, `hashes/<identity>.json` in the `AppData` root,
 * never in the folder. `home()` loads this module when the folder opens, so
 * a browser never loads it.
 */
import type { Result } from 'wellcrafted/result';
import type { StampFile } from './device/stamp-cache.js';
import type { Store } from './device/store.js';
import type { OpenFolderError } from './errors.js';
import { commands } from './native/bindings.gen.js';
import { openRoot } from './native/root.js';
import { hashesPath, storeStampFile } from './platform/records.js';

export { revealRoot } from './tauri.js';

/** A cache file made once it is first used. */
function lazily(make: () => Promise<StampFile | null>): StampFile {
	let file: Promise<StampFile | null> | undefined;
	return {
		async load() {
			file ??= make();
			return (await (await file)?.load()) ?? null;
		},
		async save(bytes) {
			file ??= make();
			await (await file)?.save(bytes);
		},
	};
}

/** The Data root's hash cache in the app's own data, named by the Data root's identity. */
async function dataHashes(): Promise<StampFile | null> {
	try {
		const identity = await commands.rootIdentity('Data');
		if (identity.error !== null || identity.data === null) return null;
		const appData = await openRoot('AppData');
		if (appData.error !== null) return null;
		return storeStampFile(appData.data.store, hashesPath(identity.data));
	} catch {
		return null;
	}
}

/**
 * Open the data folder as a store, with the path the shell answered for it
 * (to show a person; no command takes it).
 */
export function openDataFolder(): Promise<
	Result<{ store: Store; path: string }, OpenFolderError>
> {
	return openRoot('Data', { hashes: lazily(dataHashes) });
}
