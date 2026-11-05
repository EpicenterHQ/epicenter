/**
 * The one line Settings adds on the web when Safari may clear Whispering's
 * files. WebKit deletes a site's script-written storage, this browser's
 * files included, after days of browsing without a visit to the site,
 * unless the browser has made that storage persistent
 * (`navigator.storage.persisted()`). Chromium and Firefox keep it until the
 * disk runs short. The desktop app keeps its recordings as files and never
 * shows the line.
 *
 * The browser is WebKit when `navigator.vendor` is `Apple Computer, Inc.`:
 * every WebKit browser says so, Safari and every browser on iOS (all run
 * WebKit, so all are under its rule), and Chromium browsers say
 * `Google Inc.` and Firefox nothing. One equality is harder to get wrong than
 * a user-agent pattern, where Chromium's string names `AppleWebKit` and
 * `Safari` too. A desktop window is WebKit as well on macOS, which is why the
 * variant is asked first.
 */
import type { Variant } from './platform/types.js';
import { sentences } from './sentences.js';

/** What every WebKit browser answers for `navigator.vendor`. */
const WEBKIT_VENDOR = 'Apple Computer, Inc.';

export const EVICTION_NOTE = sentences(
	'Safari may clear these recordings if you don’t visit for a while',
	'The desktop app keeps them as files in your Epicenter folder',
);

/**
 * The line to show, or undefined: only in the web build, only in WebKit,
 * only while this browser keeps Whispering's files at all (a private window
 * keeps none, and the root's status line says the files cannot be
 * reached), and only while they are not
 * persistent. `persisted` is undefined until the browser answers, or when
 * it cannot, and then nothing is said.
 */
export function evictionNote({
	variant,
	vendor,
	storageWorks,
	persisted,
}: {
	variant: Variant;
	vendor: string;
	storageWorks: boolean;
	persisted: boolean | undefined;
}): string | undefined {
	if (variant !== 'local' || vendor !== WEBKIT_VENDOR) return undefined;
	return storageWorks && persisted === false ? EVICTION_NOTE : undefined;
}

/** Whether this browser has made the site's storage persistent, or undefined when it cannot say. */
export async function readPersisted(
	storage: Pick<StorageManager, 'persisted'> | undefined = globalThis.navigator
		?.storage,
): Promise<boolean | undefined> {
	try {
		return await storage?.persisted();
	} catch {
		return undefined;
	}
}
