/**
 * What the host serves, and what a person can launch from the Folders window
 * (ADR-0189, ADR-0537).
 *
 * A compiled application ships in the release and is served from its own
 * built-in route behind the host's session gate. The Folders window needs only
 * an ID the host can resolve to a window and a title to show; the window label,
 * capability file, and served document are decided by the host when it
 * launches one.
 *
 * Settings (the `home` window) is not in the list: it is the host's own
 * document, not a compiled application, and the Folders window opens it from
 * its own button. Neither is a release-bundled placeholder document, because
 * there is nothing behind it to open.
 */

import { BUILT_IN_ROUTES } from './routes.ts';

/** One application a person can launch, however the host serves it. */
export type Application = {
	id: string;
	title: string;
	/**
	 * An app installed from its source (ADR-0540), opened with
	 * `open_installed_app` on the folder it is offered on, rather than a
	 * compiled one opened with `launch_application`.
	 */
	installed?: true;
};

export const WHISPERING_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.whispering.id,
	title: BUILT_IN_ROUTES.whispering.title,
};

export const CAPTURE_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.capture.id,
	title: BUILT_IN_ROUTES.capture.title,
};

export const TODOS_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.todos.id,
	title: BUILT_IN_ROUTES.todos.title,
};

/** The host's own window over every data folder under the folder root. */
export const FOLDERS_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.folders.id,
	title: BUILT_IN_ROUTES.folders.title,
};

/**
 * Settings, which the Folders window opens beside its folders. Its window
 * keeps the label `home`.
 */
export const SETTINGS_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.home.id,
	title: BUILT_IN_ROUTES.home.title,
};

/**
 * Compiled applications, in the order the Folders window lists the
 * launchable ones (`LAUNCHABLE_APPLICATIONS`).
 *
 * This is also the list the host loads asset trees for at boot: a compiled
 * application is exactly a `dist/<id>` build the release ships, so declaring
 * one here and building it are the two halves of the same act.
 */
export const COMPILED_APPLICATIONS: readonly Application[] = [
	WHISPERING_APPLICATION,
	CAPTURE_APPLICATION,
	TODOS_APPLICATION,
	FOLDERS_APPLICATION,
];

/**
 * The compiled applications a person can launch, in the order the Folders
 * window lists them.
 *
 * Whispering is built and served but not launchable for now: inside Epicenter
 * no folder or host of its own is registered for it, so its page can only
 * report that the desktop app did not start Whispering's host. Dropping this
 * filter, and returning `true` for it from `BuiltInApp::is_hosted` in Rust,
 * offers it again.
 *
 * Rust holds the matching decision for its own built-in app table
 * (`BuiltInApp::is_launchable`). Both sides are small closed lists rather than
 * a shared manifest, and each is checked against this one by its own tests.
 */
export const LAUNCHABLE_APPLICATIONS: readonly Application[] =
	COMPILED_APPLICATIONS.filter(({ id }) => id !== WHISPERING_APPLICATION.id);
