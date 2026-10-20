/**
 * Opening one window from the Folders window, and the sentence shown when it
 * fails.
 *
 * Each act asks the shell, which decides the window's folder in Rust and
 * binds it to the window before the window exists; the page passes a listed
 * folder's name at most, never a path:
 *
 * - `launch` opens an app Epicenter bundles, Todos, Capture, Honeycrisp, or
 *   Whispering, with `open_bundled_app`: on the folder the Folders window
 *   listed, or on its default folder;
 * - `choose` opens an app on a folder the person chooses in the native
 *   picker, which the shell opens and answers (`choose_folder_for_app`);
 * - `editFolder` opens a listed folder's own editor window
 *   (`open_folder_editor`).
 *
 * The same folder again reveals its window. Nothing here remembers who asked
 * or where they came from (ADR-0189); a window is opened because a person
 * clicked, and that is the whole state. Each caller gets its own instance,
 * so a failure is reported where the click happened rather than following
 * the user into another pane.
 */

import type { Opener } from '../folders/openers.ts';
import { commands } from './bindings.gen';

export function createLaunch() {
	let failure = $state<string | null>(null);

	/** Run one request to the shell, saying `what` did not open when it fails. */
	async function attempt(
		what: string,
		request: () => Promise<{ error: string | null }>,
	) {
		failure = null;
		try {
			const { error } = await request();
			if (error !== null) throw new Error(error);
		} catch (error) {
			failure = `${what} did not open. ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	}

	return {
		/** The last launch failure, or `null` when nothing has gone wrong. */
		get failure() {
			return failure;
		},
		/** Open `application` on the listed folder `folder`, or on its default folder. */
		launch(application: Opener, folder?: string) {
			return attempt(application.title, () =>
				commands.openBundledApp(application.app, folder ?? null),
			);
		},
		/** Open `application` on a folder the person chooses; cancelling opens nothing. */
		choose(application: Opener) {
			return attempt(application.title, () =>
				commands.chooseFolderForApp(application.app),
			);
		},
		/** Open the listed folder `folder` in its own editor window. */
		editFolder(folder: string) {
			return attempt(folder, () => commands.openFolderEditor(folder));
		},
	};
}
