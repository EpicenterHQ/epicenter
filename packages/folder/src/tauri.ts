/**
 * `@epicenter/folder/tauri`: what a desktop page asks the shell about its
 * folder beyond reading and writing it: show a root in the file manager
 * (`revealRoot`), and Epicenter's sync enrollment (`syncWithEpicenter`,
 * `syncedWithEpicenter`). An app opens its folder with
 * `openFolder(contract, home({ site }))` from `@epicenter/folder`, which on
 * the desktop is the `Data` root the shell named; what a capability keeps
 * on this computer goes to `AppData` through `settings` from
 * `@epicenter/local`.
 */
import { Ok, type Result } from 'wellcrafted/result';
import { RevealRootError } from './errors.js';
import { commands, type Root } from './native/bindings.gen.js';

export type { FolderRequest } from './desktop-folder.js';
export { syncedWithEpicenter, syncWithEpicenter } from './epicenter-sync.js';
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
