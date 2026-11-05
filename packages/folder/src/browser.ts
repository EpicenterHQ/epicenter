/**
 * This browser's storage as a place: this origin's private file system
 * (OPFS), at the same paths a desktop folder holds, which an app's local
 * web variant keeps its files in for good and never uploads (ADR-0700).
 * The page reads and writes the files itself (`device/opfs-store.ts`).
 */
import { Ok } from 'wellcrafted/result';
import { DeviceError, opfsStore } from './device/opfs-store.js';
import { OpenFolderError } from './errors.js';
import { type Place, place } from './place.js';

/**
 * This origin's private file system, or `StorageUnavailable` where the
 * browser gives the page no private storage (WebKit's ephemeral contexts,
 * Safari's private windows, a context with no file system at all), whose
 * cause is a `DeviceError.StorageRefused`. Waiting will not fix it, so the
 * folder fails and says why (ADR-0775).
 */
export function browserStorage(): Place {
	return place(() => ({
		async open() {
			try {
				await navigator.storage.getDirectory();
			} catch (cause) {
				return OpenFolderError.StorageUnavailable({
					cause: DeviceError.StorageRefused({ cause }).error,
				});
			}
			return Ok(opfsStore());
		},
	}));
}
