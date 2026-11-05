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
 * This origin's private file system, or `StorageUnavailable` in a context
 * with no Worker to own the files. The Worker starts at the first call, and
 * stops when the folder is disposed. A browser that gives the page no
 * private storage (WebKit's ephemeral contexts, Safari's private windows)
 * still opens: each call is then `Unavailable`, its cause a
 * `DeviceError.StorageRefused`, so an app can still render and explain why
 * nothing is kept (Whispering refuses to record there).
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
			return Ok(opfsStore());
		},
	}));
}
