/** What Home may do natively, and how it knows whether it may (ADR-0189). */

import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * Whether this Home document is running inside the Epicenter desktop host.
 *
 * Synchronous on purpose: the host injects its IPC bootstrap before any module
 * runs, so the first paint already knows which pane to land on and which panes
 * can act. Home is also served to a plain browser and to a remote device
 * attached to the session, and neither can open a window or reach a
 * device-local model.
 */
export function isDesktopHost(): boolean {
	return isTauri();
}

/**
 * Reveal and focus one application's window, creating it the first time
 * (ADR-0189). The caller passes an ID and nothing else; the host derives the
 * URL and window label itself.
 *
 * Pass only IDs from `applications.ts`. The native side keeps its own closed
 * table of the applications it can open and refuses any other ID.
 *
 * Resolves when the window is actually open and focused, and rejects with the
 * host's own sentence when it is not, so a caller has something true to show.
 *
 * Held by the Folders window and Settings, and by no application window.
 */
export async function launchApplication(id: string): Promise<void> {
	await invoke('launch_application', { appId: id });
}
