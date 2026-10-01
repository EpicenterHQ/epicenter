/**
 * The system clipboard's text, selected for the current environment: the browser leaf uses
 * the page's Clipboard API and the `epicenter-host` leaf uses the host's
 * clipboard plugin. Importing acquires nothing, and no App handle is involved:
 * a clipboard captures no App or account, so it lives beside
 * the App rather than on it.
 */

import { isTauri } from '@tauri-apps/api/core';
import { clipboard as browser } from './clipboard/browser.js';
import { clipboard as host } from './clipboard/epicenter-host.js';

// Unlike defaultRuntime, this value selects at import; the environment stays fixed.
export const clipboard = isTauri() ? host : browser;
export {
	type Clipboard,
	ClipboardError,
	type ClipboardSource,
	createClipboard,
} from './clipboard/contract.js';
