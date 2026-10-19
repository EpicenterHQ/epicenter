/**
 * Which storage this page opens, decided before any of it opens.
 *
 * - The desktop build opens the folder the Epicenter shell grants its window,
 *   as before (`legacy`).
 * - A browser that holds the OPFS directory an earlier build kept its todos
 *   in, `so.epicenter.todos`, keeps opening it the way that build did
 *   (`legacy`), until a verified migration brings those todos across.
 * - Any other browser opens this origin's local folder (`local`), which a
 *   fresh profile starts empty.
 * - When the check itself fails, nothing opens (`unknown`): an empty local
 *   folder would look as if the earlier todos were lost.
 *
 * The check only looks: it creates no directory and writes nothing. Nothing
 * is migrated or deleted here.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { TODOS_FOLDER_ID } from './definition.js';

export type StorageChoice =
	| { readonly storage: 'legacy' }
	| { readonly storage: 'local' }
	| { readonly storage: 'unknown'; readonly reason: string };

/** The part of `navigator.storage` the check reads. */
export type OpfsAccess = {
	getDirectory(): Promise<{
		getDirectoryHandle(name: string): Promise<unknown>;
	}>;
};

export async function chooseStorage({
	installed = import.meta.env.EPICENTER_HOST === '1',
	storage = globalThis.navigator?.storage as Partial<OpfsAccess> | undefined,
}: {
	/** Whether this is the build Epicenter installs. */
	installed?: boolean;
	storage?: Partial<OpfsAccess>;
} = {}): Promise<StorageChoice> {
	if (installed) return { storage: 'legacy' };
	// Without OPFS no earlier build could have kept todos in this browser.
	if (typeof storage?.getDirectory !== 'function') return { storage: 'local' };
	try {
		const root = await storage.getDirectory();
		// No `create`: this only finds a directory that is already there.
		await root.getDirectoryHandle(TODOS_FOLDER_ID);
		return { storage: 'legacy' };
	} catch (cause) {
		if ((cause as { name?: unknown } | null)?.name === 'NotFoundError')
			return { storage: 'local' };
		return { storage: 'unknown', reason: extractErrorMessage(cause) };
	}
}
