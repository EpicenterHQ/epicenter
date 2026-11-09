/**
 * `@epicenter/folder/served`: the directory the program serving this page
 * keeps on this computer, as a place (ADR-0784). The page reaches it only
 * through that program, which answers the store's four verbs over the
 * directory (`serveDirectory` from `@epicenter/folder/serve`); see
 * `served/wire.ts`. Nothing is kept in this browser.
 *
 * ```ts
 * export const folder = openFolder(messages, served('/folder'));
 * ```
 */
import { Ok } from 'wellcrafted/result';
import { OpenFolderError } from './errors.js';
import { type Place, place } from './place.js';
import { probe, servedStore } from './served/store.js';

/**
 * The directory the program at `url` (a path on this page's origin, or a
 * full URL) serves. While the program cannot be reached the folder keeps
 * trying (`Unavailable`); a page that something else served, where nothing
 * at `url` answers for a directory, fails the open with
 * `StorageUnavailable`.
 */
export function served(url: string): Place {
	const base = url.replace(/\/+$/, '');
	return place(() => ({
		async open() {
			const answered = await probe(base);
			if (answered.error !== null) return answered;
			if (answered.data === 'not served')
				return OpenFolderError.StorageUnavailable({
					cause: `nothing at ${base} keeps this app's files: the page was not opened from its program`,
				});
			return Ok(servedStore(base));
		},
	}));
}
