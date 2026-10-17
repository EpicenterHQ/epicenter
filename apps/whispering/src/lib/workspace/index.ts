/**
 * Opens the workspace this page was given.
 *
 * The build decides which storage it has (ADR-0391): the build Epicenter
 * serves (ADR-0493, ADR-0552) resolves `#platform/workspace` to the desktop
 * workspace, whose folder is the one Epicenter's shell grants; every other
 * build resolves it to the browser workspace, this browser's own storage.
 * Neither build carries the other's adapter, and the browser workspace
 * refuses inside a desktop app, so a desktop window never opens browser
 * storage.
 */
export { openWorkspace } from '#platform/workspace';
export type {
	OpenWorkspace,
	WhisperingFolder,
	Workspace,
	WorkspaceError,
} from './types.js';
