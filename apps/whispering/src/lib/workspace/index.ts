/**
 * Opens the workspace this page was given.
 *
 * Where the page runs decides which storage it has: inside a desktop app the
 * page is Whispering installed in Epicenter (ADR-0493, ADR-0552), and its
 * folder is the one Epicenter's shell grants; in a browser tab it is this
 * browser's own. That is asked of the runtime, never inferred from anything
 * the host injected.
 *
 * The desktop workspace and its Tauri adapter are loaded only when the page is
 * inside a desktop app, so a browser tab never loads them.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { Result } from 'wellcrafted/result';
import type { Workspace, WorkspaceError } from './types.js';

export type {
	InjectionState,
	TerminalResult,
	WhisperingFolder,
	Workspace,
	WorkspaceError,
	WorkspaceTerminal,
} from './types.js';

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
	const { openDesktopWorkspace } = await import('./desktop.js');
	return openDesktopWorkspace();
}
