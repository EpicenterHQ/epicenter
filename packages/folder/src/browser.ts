/**
 * This browser's storage as a place: this origin's private file system
 * (OPFS), at the same paths a desktop folder holds, which an app's local
 * web variant keeps its files in for good and never uploads (ADR-0700).
 * One dedicated Worker per open owns the files (`device/opfs-store.ts`).
 */
import { Ok } from 'wellcrafted/result';
import { DeviceError, opfsStore } from './device/opfs-store.js';
import { OpenFolderError } from './errors.js';
import { type Place, place } from './place.js';

/**
 * This origin's private file system, or `StorageUnavailable` where it
 * cannot be: a context with no Worker to own the files, or a browser that
 * gives the page no private storage (WebKit's ephemeral contexts, Safari's
 * private windows), whose cause is a `DeviceError.StorageRefused`. Waiting
 * will not fix either, so the folder fails and says why (ADR-0775). The
 * Worker starts at the first call, and stops when the folder is disposed.
 */
export function browserStorage(): Place {
	return place(() => ({
		async open() {
			if (typeof Worker === 'undefined')
				return OpenFolderError.StorageUnavailable({
					cause: DeviceError.WorkerFailed({
						cause: 'this context has no Worker',
					}).error,
				});
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
