/**
 * What a person can launch from Epicenter Home (ADR-0189).
 *
 * Two sources, one list. A compiled application ships in the release and is
 * served from its own built-in route behind the host's session gate. An admitted
 * application is a member of the catalog: one immutable generation of inert
 * built folders, selected once at startup (ADR-0179). "Catalog" keeps that
 * narrower meaning everywhere; this list is not one, and admitting a folder is
 * not what puts a compiled application in it.
 *
 * What the two sources share is the only thing Home needs: an ID the host can
 * resolve to a window, and a title to show. Everything they do not share
 * (window label, capability file, how Bun serves the document) is decided by
 * the host when Home launches one, so nothing downstream branches on origin.
 *
 * Home is not in the list, for a smaller reason than it used to be: you are
 * already looking at it, so launching it is a no-op rather than a window
 * (ADR-0209). It is not above the others, it simply has no second copy to open.
 * Neither is a release-bundled placeholder document, because there is nothing
 * behind it to open. Both remain reserved built-in IDs the catalog refuses to
 * admit, so "not launchable" never means "available for someone else to claim".
 */

import { APPS } from '@epicenter/constants/apps';
import { BUILT_IN_ROUTES } from './routes.ts';

/** One application a person can launch, however the host serves it. */
export type Application = {
	id: string;
	title: string;
};

/**
 * The compiled applications this release can launch.
 *
 * Rust holds the matching decision for its own built-in app table
 * (`BuiltInApp::is_launchable`). Both sides are small closed lists rather than a
 * shared manifest, and each is checked against this one by its own tests.
 */
export const WHISPERING_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.whispering.id,
	title: BUILT_IN_ROUTES.whispering.title,
};

export const HONEYCRISP_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.honeycrisp.id,
	title: BUILT_IN_ROUTES.honeycrisp.title,
};

export const MAIL_APPLICATION: Application = {
	id: BUILT_IN_ROUTES.mail.id,
	title: BUILT_IN_ROUTES.mail.title,
};

/**
 * Compiled applications, in the order Home lists them.
 *
 * This is also the list the host loads asset trees for at boot: a compiled
 * application is exactly a `dist/<id>` build the release ships, so declaring
 * one here and building it are the two halves of the same act.
 */
export const COMPILED_APPLICATIONS: readonly Application[] = [
	WHISPERING_APPLICATION,
	HONEYCRISP_APPLICATION,
	MAIL_APPLICATION,
];

/** IDs that belong to Epicenter's own built-in routes and cannot be installed. */
export const RESERVED_APPLICATION_IDS: readonly string[] = [
	...Object.values(BUILT_IN_ROUTES).map((route) => route.id),
	APPS.WHISPERING.id,
	APPS.HONEYCRISP.id,
	APPS.VOCAB.id,
	'so.epicenter.local-mail',
];
