import { createSystemShortcuts } from '#platform/system-shortcuts';
import { commands } from '$lib/commands';
import type { WhisperingApp } from '$lib/whispering/app';
import { createFocusedShortcuts } from './focused';
import { createReachRouter } from './reach-router';

/**
 * The live shortcut surface: the reach router (ADR-0052) over the universal
 * focused backend and the Tauri-only system backend. A write routes to the
 * synced focused store or the per-device global store by its realized reach, so
 * the user picks a key, never a store; `sync()` pushes both backends, which is
 * what makes the focused (in-app) shortcuts run on desktop alongside the global
 * ones. On web `systemShortcuts` is `null`, so the router caps every binding at
 * focused reach.
 */
export function createAppShortcuts(app: WhisperingApp) {
	return createReachRouter({
		focused: createFocusedShortcuts(app),
		global: createSystemShortcuts?.(app) ?? null,
		commands,
	});
}
