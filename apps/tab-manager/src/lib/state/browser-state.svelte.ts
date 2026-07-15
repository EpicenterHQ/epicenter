/**
 * Reactive browser state for the side panel.
 *
 * Seeds from `browser.windows.getAll({ populate: true })` and receives
 * surgical updates via browser event listeners. Uses a single
 * `SvelteMap<number, WindowState>` where each window owns its tabs.
 *
 * Chrome is the sole authority for live tab state. Only explicit web captures
 * cross into Epicenter's synchronized SQLite workspace.
 *
 * Lifecycle: Created when side panel opens. All listeners die when panel closes.
 * Next open → fresh seed + fresh listeners. No cleanup needed.
 *
 * @example
 * ```svelte
 * <script>
 *   import { browserState } from '$lib/state/browser-state.svelte';
 * </script>
 *
 * {#each browserState.windows as window (window.id)}
 *   {#each browserState.tabsByWindow(window.id) as tab (tab.id)}
 *     <TabItem {tab} />
 *   {/each}
 * {/each}
 * ```
 */

import { SvelteMap } from 'svelte/reactivity';
import type { Brand } from 'wellcrafted/brand';
import { type Browser, browser } from 'wxt/browser';

const TAB_ID_NONE = -1;

// ── Branded ID Types ─────────────────────────────────────────────────

/** Branded tab ID, guaranteed valid (not undefined, not TAB_ID_NONE). */
type TabId = number & Brand<'TabId'>;

/** Brand a raw tab ID, rejecting undefined and TAB_ID_NONE. */
function TabId(raw: number | undefined): TabId | null {
	if (raw == null || raw === TAB_ID_NONE) return null;
	return raw as TabId;
}

/** Branded window ID, guaranteed valid (not undefined). */
type WindowId = number & Brand<'WindowId'>;

/** Brand a raw window ID, rejecting undefined. */
function WindowId(raw: number | undefined): WindowId | null {
	if (raw == null) return null;
	return raw as WindowId;
}

// ── Narrowed Chrome Types ────────────────────────────────────────────

/** Chrome tab with a guaranteed branded {@link TabId}. */
export type BrowserTab = Browser.tabs.Tab & { id: TabId };

/**
 * Narrow a Chrome tab to {@link BrowserTab}, returning null if `id`
 * is missing or reserved.
 *
 * No object creation. Validates the ID via {@link TabId} and asserts
 * the object type. This is the sole ingestion boundary for Chrome tabs.
 */
function BrowserTab(tab: Browser.tabs.Tab): BrowserTab | null {
	if (TabId(tab.id) == null) return null;
	return tab as BrowserTab;
}

/** Chrome window with a guaranteed branded {@link WindowId}. */
export type BrowserWindow = Browser.windows.Window & { id: WindowId };

/** Narrow a Chrome window to {@link BrowserWindow}, returning null if `id` is missing. */
function BrowserWindow(win: Browser.windows.Window): BrowserWindow | null {
	if (WindowId(win.id) == null) return null;
	return win as BrowserWindow;
}

/**
 * A window and all the tabs it owns, stored together.
 *
 * Browser state is inherently hierarchical: tabs belong to windows. Storing
 * them as a coupled unit means every access pattern (render a window's tabs,
 * remove a window and its tabs, switch active tab within a window) is a direct
 * lookup instead of a filter-all-tabs scan.
 *
 * Each window gets its own inner `SvelteMap` for tabs. Svelte 5's reactivity
 * tracks each SvelteMap independently, so mutating one window's tabs only
 * re-renders that window's `{#each}` block, not every window.
 */
type WindowState = {
	window: BrowserWindow;
	tabs: SvelteMap<number, BrowserTab>;
};

function createBrowserState() {
	/**
	 * Single source of truth for all browser windows and tabs.
	 *
	 * Keyed by Chrome's native window ID so every lookup is O(1). The outer
	 * SvelteMap triggers reactivity when windows are added/removed; each inner
	 * SvelteMap triggers reactivity when that window's tabs change.
	 */
	const windowStates = new SvelteMap<number, WindowState>();

	/**
	 * Set to true only AFTER the seed populates `windowStates`.
	 *
	 * Every event handler guards with `if (!seeded) return`, which means
	 * events that arrive before the seed completes are silently dropped
	 * (they'd be stale anyway; the seed is the authoritative snapshot).
	 */
	let seeded = false;

	// ── Seed ─────────────────────────────────────────────────────────────
	// Single IPC call via `getAll({ populate: true })` returns windows with
	// their tabs already nested, which is a natural fit for our WindowState shape.

	const whenReady = (async () => {
		const browserWindows = await browser.windows.getAll({ populate: true });

		for (const win of browserWindows) {
			const bw = BrowserWindow(win);
			if (!bw) continue;

			const tabsMap = new SvelteMap<number, BrowserTab>();
			if (win.tabs) {
				for (const tab of win.tabs) {
					const bt = BrowserTab(tab);
					if (bt) tabsMap.set(bt.id, bt);
				}
			}

			windowStates.set(bw.id, { window: bw, tabs: tabsMap });
		}

		seeded = true;
	})();

	// ── Tab Event Listeners ──────────────────────────────────────────────

	// onCreated: Full Tab object provided
	browser.tabs.onCreated.addListener((tab) => {
		if (!seeded) return;
		const bt = BrowserTab(tab);
		if (!bt) return;
		windowStates.get(bt.windowId)?.tabs.set(bt.id, bt);
	});

	// onRemoved: Use removeInfo.windowId for a direct window lookup instead
	// of scanning all tabs. When isWindowClosing is true, the window's
	// onRemoved handler will delete the entire WindowState (and all its tabs
	// with it), so per-tab cleanup is unnecessary.
	browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
		if (!seeded) return;
		if (removeInfo.isWindowClosing) return;
		windowStates.get(removeInfo.windowId)?.tabs.delete(tabId);
	});

	// onUpdated: Full Tab in 3rd arg; route to correct window
	browser.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
		if (!seeded) return;
		const bt = BrowserTab(tab);
		if (!bt) return;
		windowStates.get(bt.windowId)?.tabs.set(bt.id, bt);
	});

	// onMoved: Re-query tab to get updated index
	browser.tabs.onMoved.addListener(async (tabId) => {
		if (!seeded) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const bt = BrowserTab(tab);
			if (!bt) return;
			windowStates.get(bt.windowId)?.tabs.set(bt.id, bt);
		} catch {
			// Tab may have been closed during move
		}
	});

	// onActivated: Only scans the affected window's tabs (not all tabs across
	// all windows) to flip the active flag. This is the main perf win of the
	// coupled structure. A 50-tab window with 5 other windows only iterates 50
	// tabs, not 300.
	browser.tabs.onActivated.addListener((activeInfo) => {
		if (!seeded) return;
		const state = windowStates.get(activeInfo.windowId);
		if (!state) return;

		// Deactivate previous active tab(s) in this window only
		for (const [id, tab] of state.tabs) {
			if (tab.active) {
				state.tabs.set(id, { ...tab, active: false } as BrowserTab);
			}
		}

		// Activate the new tab
		const tab = state.tabs.get(activeInfo.tabId);
		if (tab) {
			state.tabs.set(activeInfo.tabId, {
				...tab,
				active: true,
			} as BrowserTab);
		}
	});

	// ── Attach / Detach ──────────────────────────────────────────────────
	// Moving a tab between windows fires two events in order:
	//   1. onDetached (old window): we remove the tab from the old window's map
	//   2. onAttached (new window): we re-query the tab and add it to the new
	//      window's map (re-query is needed to get the updated windowId + index)
	//
	// Between detach and attach, the tab exists in neither window. This is fine
	// because the side panel doesn't render mid-event-dispatch.

	browser.tabs.onAttached.addListener(async (tabId) => {
		if (!seeded) return;
		try {
			const tab = await browser.tabs.get(tabId);
			const bt = BrowserTab(tab);
			if (!bt) return;
			windowStates.get(bt.windowId)?.tabs.set(bt.id, bt);
		} catch {
			// Tab may have been closed
		}
	});

	browser.tabs.onDetached.addListener((tabId, detachInfo) => {
		if (!seeded) return;
		windowStates.get(detachInfo.oldWindowId)?.tabs.delete(tabId);
	});

	// ── Window Event Listeners ───────────────────────────────────────────

	// onCreated: Full Window object provided
	browser.windows.onCreated.addListener((win) => {
		if (!seeded) return;
		const bw = BrowserWindow(win);
		if (!bw) return;
		windowStates.set(bw.id, { window: bw, tabs: new SvelteMap() });
	});

	// onRemoved: Deleting the WindowState entry removes the window AND all its
	// tabs in one operation. No orphan cleanup needed.
	browser.windows.onRemoved.addListener((windowId) => {
		if (!seeded) return;
		windowStates.delete(windowId);
	});

	// onFocusChanged: We call `windowStates.set()` (not just mutate the
	// window object in place) because the `window` property is a plain object,
	// not wrapped in $state. Calling `.set()` on the outer SvelteMap bumps its
	// version signal, which notifies the `windows` getter's consumers.
	browser.windows.onFocusChanged.addListener((windowId) => {
		if (!seeded) return;

		for (const [id, state] of windowStates) {
			if (state.window.focused) {
				windowStates.set(id, {
					...state,
					window: { ...state.window, focused: false } as BrowserWindow,
				});
			}
		}

		// WINDOW_ID_NONE means all windows lost focus (e.g. user clicked desktop)
		if (windowId !== browser.windows.WINDOW_ID_NONE) {
			const state = windowStates.get(windowId);
			if (state) {
				windowStates.set(windowId, {
					...state,
					window: { ...state.window, focused: true } as BrowserWindow,
				});
			}
		}
	});

	// ── Derived State ────────────────────────────────────────────────────

	const windows = $derived(
		windowStates
			.values()
			.map((s) => s.window)
			.toArray(),
	);

	return {
		/**
		 * Resolves after the initial browser state seed completes.
		 *
		 * Use this to gate UI rendering so child components can safely read
		 * `windows` and `tabsByWindow` synchronously at construction time.
		 *
		 * @example
		 * ```svelte
		 * {#await browserState.whenReady}
		 *   <LoadingSpinner />
		 * {:then}
		 *   <UnifiedTabList />
		 * {/await}
		 * ```
		 */
		get whenReady() {
			return whenReady;
		},

		/** All browser windows. */
		get windows() {
			return windows;
		},

		/**
		 * Get tabs for a specific window, sorted by tab strip index.
		 *
		 * @example
		 * ```svelte
		 * {#each browserState.tabsByWindow(window.id) as tab (tab.id)}
		 *   <TabItem {tab} />
		 * {/each}
		 * ```
		 */
		tabsByWindow(windowId: number): BrowserTab[] {
			const state = windowStates.get(windowId);
			if (!state) return [];
			return [...state.tabs.values()].sort((a, b) => a.index - b.index);
		},

		/**
		 * Close a tab. Browser onRemoved event updates state.
		 *
		 * None of these methods mutate `windowStates` directly. They call the
		 * browser API, which fires an event (e.g. `onRemoved`, `onUpdated`),
		 * and the event listener above handles the state update.
		 */
		async close(tabId: number) {
			await browser.tabs.remove(tabId);
		},

		/** Activate a tab and focus its window. */
		async activate(tabId: number) {
			const tab = await browser.tabs.update(tabId, { active: true });
			if (tab?.windowId) {
				await browser.windows.update(tab.windowId, { focused: true });
			}
		},

		/** Pin a tab. */
		async pin(tabId: number) {
			await browser.tabs.update(tabId, { pinned: true });
		},

		/** Unpin a tab. */
		async unpin(tabId: number) {
			await browser.tabs.update(tabId, { pinned: false });
		},

		/** Mute a tab. */
		async mute(tabId: number) {
			await browser.tabs.update(tabId, { muted: true });
		},

		/** Unmute a tab. */
		async unmute(tabId: number) {
			await browser.tabs.update(tabId, { muted: false });
		},

		/** Reload a tab. */
		async reload(tabId: number) {
			await browser.tabs.reload(tabId);
		},

		/** Duplicate a tab. */
		async duplicate(tabId: number) {
			await browser.tabs.duplicate(tabId);
		},
	};
}

export const browserState = createBrowserState();
