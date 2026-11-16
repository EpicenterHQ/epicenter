/**
 * `@epicenter/folder/tauri`: what a desktop page asks the shell about its
 * folder beyond reading and writing it: show a root in the file manager
 * (`revealRoot`); and, in the Epicenter app, the Epicenter folder with
 * every folder in it (`epicenterRoot`), which the platform's functions in
 * `@epicenter/folder/platform` take. An app opens its folder with
 * `openFolder(contract, home({ site }))` from `@epicenter/folder`, which on
 * the desktop is the `Data` root the shell named; what a capability keeps
 * on this computer goes to `AppData` through `settings` from
 * `@epicenter/local`. A desktop app never syncs (ADR-0822).
 */
import { Ok, type Result } from 'wellcrafted/result';
import { RevealRootError } from './errors.js';
import { commands, type Root } from './native/bindings.gen.js';

export type { Root } from './native/bindings.gen.js';
export { epicenterRoot } from './native/epicenter-root.js';

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
