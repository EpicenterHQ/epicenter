/** Flat, searchable view over browser-owned tabs and synchronized captures. */

import { SvelteSet } from 'svelte/reactivity';
import type { WebCapture } from '../../../tab-manager.js';
import type { BrowserTab, BrowserWindow } from './browser-state.svelte.js';
import { browserState } from './browser-state.svelte.js';
import type { WebCaptureState } from './web-capture-state.svelte.js';

export type SectionId = 'open-tabs' | 'captures';

export type FlatItem =
	| { kind: 'section-header'; section: SectionId; label: string; count: number }
	| { kind: 'window-header'; window: BrowserWindow }
	| { kind: 'tab'; tab: BrowserTab }
	| { kind: 'capture'; capture: WebCapture };

export function createUnifiedViewState(captures: WebCaptureState) {
	const expandedSections = new SvelteSet<SectionId>(['open-tabs', 'captures']);
	let searchQuery = $state('');
	const isFiltering = $derived(searchQuery.trim() !== '');

	function matches(title: string | undefined, url: string | undefined) {
		if (!isFiltering) return true;
		const query = searchQuery.trim().toLowerCase();
		return (
			(title ?? '').toLowerCase().includes(query) ||
			(url ?? '').toLowerCase().includes(query)
		);
	}

	const flatItems = $derived.by((): FlatItem[] => {
		const items: FlatItem[] = [];
		const matchingWindows = browserState.windows.flatMap((window) => {
			const tabs = browserState
				.tabsByWindow(window.id)
				.filter((tab) => matches(tab.title, tab.url));
			return tabs.length === 0 ? [] : [{ window, tabs }];
		});
		const openTabCount = matchingWindows.reduce(
			(total, entry) => total + entry.tabs.length,
			0,
		);
		items.push({
			kind: 'section-header',
			section: 'open-tabs',
			label: 'Open tabs',
			count: openTabCount,
		});
		if (isFiltering || expandedSections.has('open-tabs')) {
			for (const { window, tabs } of matchingWindows) {
				items.push({ kind: 'window-header', window });
				for (const tab of tabs) items.push({ kind: 'tab', tab });
			}
		}

		const matchingCaptures = captures.captures.filter((capture) =>
			matches(capture.title, capture.url),
		);
		items.push({
			kind: 'section-header',
			section: 'captures',
			label: 'Captured',
			count: matchingCaptures.length,
		});
		if (isFiltering || expandedSections.has('captures')) {
			for (const capture of matchingCaptures) {
				items.push({ kind: 'capture', capture });
			}
		}

		return items;
	});

	return {
		get flatItems() {
			return flatItems;
		},
		get searchQuery() {
			return searchQuery;
		},
		set searchQuery(value: string) {
			searchQuery = value;
		},
		get isFiltering() {
			return isFiltering;
		},
		isSectionExpanded(section: SectionId) {
			return expandedSections.has(section);
		},
		toggleSection(section: SectionId) {
			if (expandedSections.has(section)) expandedSections.delete(section);
			else expandedSections.add(section);
		},
	};
}
