/**
 * What the trusted origin owns for Local Mail: Bun SQLite files under the app's
 * one directory, and OS keychain entries.
 *
 * No credential and no file handle crosses into the page; both are reached over
 * the host's same-origin storage route (ADR-0321, ADR-0310).
 */

import { createDesktopDevice } from '@epicenter/device/desktop';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';

export const device = createDesktopDevice({ appId: LOCAL_MAIL_APP_ID });

/** Explain the lifetime of the credential owned by this build. */
export const gmailSignInNotice: string =
	'Your Gmail sign-in is saved in this device’s secure store. It is not shared with other devices.';
