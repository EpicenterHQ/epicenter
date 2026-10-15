/**
 * Launching one application, and the sentence shown when it fails.
 *
 * Every launch is this call: the Folders window's "Open in" buttons, its Apps
 * list and Settings button, and the Settings shortcut that appears once local
 * transcription is ready are the same act on the same verb, not paths that
 * happen to agree today. Nothing here remembers who asked or where they came
 * from (ADR-0189); an application is launched because a person clicked, and
 * that is the whole state.
 *
 * Each caller gets its own instance, so a failure is reported where the click
 * happened rather than following the user into another pane.
 */

import type { Application } from '../applications.ts';
import { launchApplication } from './runtime.ts';

export function createLaunch() {
	let failure = $state<string | null>(null);

	return {
		/** The last launch failure, or `null` when nothing has gone wrong. */
		get failure() {
			return failure;
		},
		async launch(application: Application) {
			failure = null;
			try {
				await launchApplication(application.id);
			} catch (error) {
				failure = `${application.title} did not open. ${
					error instanceof Error ? error.message : String(error)
				}`;
			}
		},
	};
}
