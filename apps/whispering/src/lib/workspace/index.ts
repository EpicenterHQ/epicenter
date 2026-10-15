/**
 * Opens the workspace this page was given.
 *
 * Where the page runs decides which storage it has: inside a desktop app the
 * folder is the shell's, and in a browser tab it is this browser's own. That
 * is asked of the runtime, not inferred from the host's token. The desktop
 * workspace also needs the Whispering host, whose token the standalone shell
 * injects before the page runs. A desktop app that injected none is not
 * Whispering's shell, and the page says so and opens nothing.
 *
 * The desktop workspace and its Tauri adapter are loaded only when the page is
 * inside a desktop app, so a browser tab never loads them.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { Result } from 'wellcrafted/result';
import { type Workspace, WorkspaceError } from './types.js';

export type {
	InjectionState,
	TerminalResult,
	WhisperingFolder,
	Workspace,
	WorkspaceError,
	WorkspaceTerminal,
} from './types.js';

declare global {
	interface Window {
		/** Set by the Whispering desktop shell before the page runs. */
		__WHISPERING_BRIDGE__?: { readonly token: string };
	}
}

/**
 * Called from a mounted component; importing this module opens nothing. A
 * refusal is returned as it is. Inside a desktop app browser storage is never
 * opened, whatever is missing or refused.
 */
export async function openWorkspace(): Promise<
	Result<Workspace, WorkspaceError>
> {
	if (!isTauri()) {
		const { openBrowserWorkspace } = await import('./browser.js');
		return openBrowserWorkspace();
	}
	const bridge = window.__WHISPERING_BRIDGE__;
	if (bridge === undefined) return WorkspaceError.HostMissing();
	const { openDesktopWorkspace } = await import('./desktop.js');
	return openDesktopWorkspace({ origin: location.origin, token: bridge.token });
}
