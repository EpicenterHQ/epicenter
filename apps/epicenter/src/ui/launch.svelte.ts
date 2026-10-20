/**
 * Opening one app, and the sentence shown when it fails.
 *
 * The Folders window's "Open with" buttons and its Apps list are the same act:
 * on the folder it was offered on, or without one, on the app's default.
 *
 * An app Epicenter bundles, Todos, Capture, Honeycrisp, or Whispering, opens
 * with `open_bundled_app` (`src-tauri/src/bundled_apps.rs`): on the folder
 * the Folders window listed, or on its default folder. No install, approval,
 * or account is on the way; the shell assigns the window its folder.
 *
 * Nothing here remembers who asked or where they came from (ADR-0189); an
 * app is opened because a person clicked, and that is the whole state. Each
 * caller gets its own instance, so a failure is reported where the click
 * happened rather than following the user into another pane.
 */

import type { Opener } from '../folders/openers.ts';
import { commands } from './bindings.gen';

export function createLaunch() {
	let failure = $state<string | null>(null);

	return {
		/** The last launch failure, or `null` when nothing has gone wrong. */
		get failure() {
			return failure;
		},
		/** Open `application` on the scope `folder`, or on its default folder. */
		async launch(application: Opener, folder?: string) {
			failure = null;
			try {
				const { error } = await commands.openBundledApp(
					application.app,
					folder ?? null,
				);
				if (error !== null) throw new Error(error);
			} catch (error) {
				failure = `${application.title} did not open. ${
					error instanceof Error ? error.message : String(error)
				}`;
			}
		},
	};
}
