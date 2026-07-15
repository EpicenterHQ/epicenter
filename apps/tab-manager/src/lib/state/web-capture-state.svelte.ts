/** Reactive state for the synchronized web-capture inbox. */

import { fromTable } from '@epicenter/svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { TabManagerBrowser } from '../../../tab-manager.browser.js';
import type { WebCapture } from '../../../tab-manager.js';
import type { BrowserTab } from './browser-state.svelte.js';

export function createWebCaptureState(tabManager: TabManagerBrowser) {
	const capturesView = fromTable(tabManager.tables.webCaptures);
	const captures = $derived(
		capturesView.all.toSorted((a, b) =>
			b.capturedAt.localeCompare(a.capturedAt),
		),
	);
	const capturingTabIds = new SvelteSet<number>();
	const pendingCaptureIds = new SvelteSet<string>();

	return {
		whenReady: capturesView.whenReady,
		get captures() {
			return captures;
		},
		isCapturing(tabId: number) {
			return capturingTabIds.has(tabId);
		},
		isPending(captureId: string) {
			return pendingCaptureIds.has(captureId);
		},
		async capture(tab: BrowserTab): Promise<void> {
			if (!tab.url) return;
			if (capturingTabIds.has(tab.id)) return;
			capturingTabIds.add(tab.id);
			try {
				await tabManager.actions.web_captures_capture({
					url: tab.url,
					title: tab.title || 'Untitled',
					favIconUrl: tab.favIconUrl ?? null,
				});
			} finally {
				capturingTabIds.delete(tab.id);
			}
		},
		async open(capture: WebCapture): Promise<void> {
			if (pendingCaptureIds.has(capture.id)) return;
			pendingCaptureIds.add(capture.id);
			try {
				await tabManager.actions.web_captures_open({
					id: capture.id,
					url: capture.url,
				});
			} finally {
				pendingCaptureIds.delete(capture.id);
			}
		},
		async discard(capture: WebCapture): Promise<void> {
			if (pendingCaptureIds.has(capture.id)) return;
			pendingCaptureIds.add(capture.id);
			try {
				await tabManager.actions.web_captures_discard({ id: capture.id });
			} finally {
				pendingCaptureIds.delete(capture.id);
			}
		},
		[Symbol.dispose]() {
			capturesView[Symbol.dispose]();
		},
	};
}

export type WebCaptureState = ReturnType<typeof createWebCaptureState>;
