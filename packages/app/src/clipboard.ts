/**
 * The system clipboard's text, selected for the build: the browser leaf uses
 * the page's Clipboard API and the `epicenter-host` leaf uses the host's
 * clipboard plugin. Importing acquires nothing, and no App handle is involved:
 * a clipboard captures no application, library, or account, so it lives beside
 * the App rather than on it.
 */

export { clipboard } from '#platform/clipboard';
export {
	type Clipboard,
	ClipboardError,
	type ClipboardSource,
	createClipboard,
} from './clipboard/contract.js';
