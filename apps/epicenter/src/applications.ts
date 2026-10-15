/**
 * What the host compiles in and serves from its own routes (ADR-0552).
 *
 * Epicenter ships with no apps installed: every app a person opens is an
 * installed app (ADR-0540), listed by the shell and opened with
 * `open_installed_app`. What remains compiled in is the Folders window, which
 * Epicenter opens to (ADR-0537), and Whispering until it installs like every
 * other app. Settings (the `home` window) is the host's own document, not a
 * compiled application; the Folders window opens it with `open_home`.
 */

import { BUILT_IN_ROUTES } from './routes.ts';

/** One application the host serves from a built-in route. */
export type Application = {
	id: string;
	title: string;
};

export const WHISPERING_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.whispering.id,
	title: BUILT_IN_ROUTES.whispering.title,
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
 *
 * Whispering is built and served but not opened: inside Epicenter no folder or
 * host of its own is registered for it, so `BuiltInApp::is_hosted` in Rust
 * keeps its window closed.
 */
export const COMPILED_APPLICATIONS: readonly Application[] = [
	WHISPERING_APPLICATION,
	FOLDERS_APPLICATION,
];
