/**
 * Boot-time Honeycrisp client (ADR-0088: sign-in is an enhancement, never a
 * door).
 *
 * `openHoneycrispBrowser` reads the persisted `auth.state` ONCE at startup
 * and picks the workspace preset: bare local IndexedDB (signed out) or
 * principal-scoped storage plus relay sync (signed in / reauth-required).
 * Construction and hydration complete before the singleton is exported.
 * Identity changes are never an in-place swap: `reloadOnPrincipalChange` (mounted
 * in the root layout) reloads the page so the next boot re-runs this selection.
 *
 * `honeycrisp` composes that browser bundle with the app's reactive
 * folder/note/view state. The workspace is never nullable.
 */

import { auth } from '#platform/auth';
import { createHoneycrispState } from '../routes/state';
import { openHoneycrispBrowser } from './workspace/browser';

const browser = await openHoneycrispBrowser({ auth });
const state = createHoneycrispState(browser);

export const honeycrisp = {
	...browser,
	state,
	/** Resolves after both SQLite row projections have their initial snapshot. */
	whenReady: state.whenReady,
};
