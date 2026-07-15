/**
 * Minimal background service worker.
 *
 * All Y.Doc, browser event listeners, sync, and command consumer logic
 * has been consolidated into the side panel context. The background only
 * exists to configure the side panel to open on extension icon click.
 */

import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
	// Open side panel when the extension icon is clicked (Chromium-based browsers).
	// Firefox uses sidebar_action manifest key: no runtime call needed.
	if (!import.meta.env.FIREFOX) {
		browser.sidePanel
			.setPanelBehavior({ openPanelOnActionClick: true })
			.catch((error: unknown) =>
				console.error('[Background] Failed to set panel behavior:', error),
			);
	}
});
