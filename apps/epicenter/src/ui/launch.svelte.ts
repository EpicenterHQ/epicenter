/**
 * Opening the apps Epicenter bundles from the Folders window.
 *
 * Each act asks the shell, which decides the window's folder in Rust and
 * binds it to the window before the window exists; the page passes no path:
 *
 * - `launch` opens an app Epicenter bundles, Todos, Capture, Honeycrisp, or
 *   Whispering, on its fixed default folder (`open_bundled_app`);
 * - `choose` opens an app on a folder the person chooses in the native
 *   picker, which the shell opens and answers (`choose_folder_for_app`).
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

	/** Run one request to the shell, presenting the caller's failure sentence. */
	async function attempt(
		failureMessage: string,
		request: () => Promise<{ data: unknown; error: string | null }>,
	) {
		failure = null;
		try {
			const { error } = await request();
			if (error !== null) throw new Error(error);
		} catch (error) {
			failure = `${failureMessage}. ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	}

	return {
		/** The last action failure, or `null` when nothing has gone wrong. */
		get failure() {
			return failure;
		},
		/** Open `application` on its fixed default folder. */
		launch(application: Opener) {
			return attempt(`${application.title} did not open`, () =>
				commands.openBundledApp(application.app),
			);
		},
		/** Open `application` on a folder the person chooses; cancelling opens nothing. */
		choose(application: Opener) {
			return attempt(`${application.title} did not open`, () =>
				commands.chooseFolderForApp(application.app),
			);
		},
	};
}
