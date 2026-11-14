/**
 * `@epicenter/folder/tauri`: what a desktop page asks the shell about its
 * folder beyond reading and writing it: show a root in the file manager
 * (`revealRoot`), and the record Epicenter keeps of the app's folder, for
 * its marks (`syncedRecord`). An app opens its folder
 * with `openFolder(contract, home({ site }))` from `@epicenter/folder`,
 * which on the desktop is the `Data` root the shell named; what a
 * capability keeps on this computer goes to `AppData` through `settings`
 * from `@epicenter/local`. A desktop app never syncs (ADR-0822): Epicenter
 * does, when it is installed.
 */
import { Ok, type Result } from 'wellcrafted/result';
import { RevealRootError } from './errors.js';
import { commands, type Root } from './native/bindings.gen.js';
import type { FolderRecord } from './platform/records.js';

export type { Root } from './native/bindings.gen.js';

/** Ask the shell to show the location it named for `root`, even if it did not open. */
export async function revealRoot(
	root: Root,
): Promise<Result<null, RevealRootError>> {
	try {
		const answer = await commands.revealRoot(root);
		if (answer.error !== null)
			return RevealRootError.Failed({
				cause:
					'message' in answer.error ? answer.error.message : answer.error.name,
			});
		return Ok(null);
	} catch (cause) {
		return RevealRootError.Failed({ cause });
	}
}

/**
 * The record Epicenter keeps of the app's data folder (ADR-0822): the one
 * whose identity proves the open `Data` root, read by the shell and never
 * written; null when Epicenter does not sync it, or the shell cannot say.
 */
export async function syncedRecord(): Promise<FolderRecord | null> {
	try {
		const answer = await commands.dataRecord();
		return answer.error === null ? (answer.data as FolderRecord | null) : null;
	} catch {
		return null;
	}
}
