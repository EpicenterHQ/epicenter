/**
 * What a browser tab owns for Local Mail: an OPFS SQLite pool and secrets that
 * live until the page is refreshed or closed.
 *
 * A browser build has no keychain, so `secrets.get` answers `null` after a
 * reload. That is the same answer a new desktop device gives, and the
 * application already handles it (ADR-0310).
 */

import { createBrowserDevice } from '@epicenter/device/browser';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const device = createBrowserDevice({ appId: LOCAL_MAIL_APP_ID });

/** Explain the lifetime of the credential owned by this build. */
export const gmailSignInNotice: string =
	'For privacy, this browser keeps your Gmail sign-in only in memory, not on disk. Refreshing or closing the tab clears it. Your saved mail and pending changes stay on this device.';
