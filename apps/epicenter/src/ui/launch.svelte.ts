/**
 * Opening one installed app (ADR-0540, ADR-0552), and the sentence shown
 * when it fails.
 *
 * The Folders window's "Open in" buttons and its Apps list are the same act
 * on the same verb, `open_installed_app`: on the folder it was offered on, or
 * without one, on the app's own folder. The CLI answers for an approved commit
 * only, building it first when it is not the current build. A window already
 * open on the folder is revealed when it runs that commit and otherwise
 * refused, since it keeps the build it opened on. Nothing here remembers who
 * asked or where they came from
 * (ADR-0189); an app is opened because a person clicked, and that is the
 * whole state.
 *
 * Each caller gets its own instance, so a failure is reported where the click
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
		/** Open installed app `application` on the scope `folder`, or on its own folder. */
		async launch(application: Opener, folder?: string) {
			failure = null;
			try {
				const { error } = await commands.openInstalledApp(
					application.id,
					application.title,
					application.commit,
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
