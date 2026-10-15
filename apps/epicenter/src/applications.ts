/**
 * What the host compiles in and serves from its own routes (ADR-0552).
 *
 * Epicenter ships with no apps installed: every app a person opens is an
 * installed app (ADR-0540), listed by the shell and opened with
 * `open_installed_app`. What remains compiled in is the Folders window, which
 * Epicenter opens to (ADR-0537). Settings (the `home` window) is the host's own document, not a
 * compiled application; the Folders window opens it with `open_home`.
 */

import { BUILT_IN_ROUTES } from './routes.ts';

/** One application the host serves from a built-in route. */
export type Application = {
	id: string;
	title: string;
};

/** The host's own window over every data folder under the folder root. */
export const FOLDERS_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.folders.id,
	title: BUILT_IN_ROUTES.folders.title,
};

/**
 * Compiled applications: the list the host loads asset trees for at boot. A
 * compiled application is exactly a `dist/<id>` build the release ships, so
 * declaring one here and building it are the two halves of the same act.
 */
export const COMPILED_APPLICATIONS: readonly Application[] = [
	FOLDERS_APPLICATION,
];
