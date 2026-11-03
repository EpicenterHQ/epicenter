import type { StartupFailure } from '#platform/app';

declare global {
	namespace App {
		interface Error {
			message: string;
			/** Why this page's world did not open (`StartupFailed`), for the recovery screen. */
			startup?: StartupFailure;
		}
	}
}
