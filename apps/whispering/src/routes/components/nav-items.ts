import HomeIcon from '@lucide/svelte/icons/house';
import ListIcon from '@lucide/svelte/icons/list';
import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
import type { Component } from 'svelte';
import { resolve } from '$app/paths';
import type { View } from '$lib/library.svelte.js';

/** The pages each view has. */
export type Page = 'home' | 'recordings' | 'transformations';

/**
 * Every page's path, by view: "On this device" at the root, "Synced" under
 * `/synced`, the same pages in each (decision 76).
 */
const PATHS = {
	device: {
		home: resolve('/'),
		recordings: resolve('/recordings'),
		transformations: resolve('/transformations'),
	},
	synced: {
		home: resolve('/synced'),
		recordings: resolve('/synced/recordings'),
		transformations: resolve('/synced/transformations'),
	},
} as const satisfies Record<View, Record<Page, string>>;

/** Page `page` of view `view`. */
export const pathOf = (view: View, page: Page): string => PATHS[view][page];

/** Trailing slashes aside, whether `pathname` is `href` or below it. */
const under = (href: string, pathname: string) =>
	pathname === href || pathname.startsWith(`${href}/`);

/** Which page `pathname` is, in either view. */
export function pageAt(pathname: string): Page {
	for (const page of ['recordings', 'transformations'] as const)
		if (
			under(PATHS.device[page], pathname) ||
			under(PATHS.synced[page], pathname)
		)
			return page;
	return 'home';
}

export type NavItem = {
	label: string;
	href: string;
	icon: Component;
	page: Page;
};

/** View `view`'s pages. The sidebar and the bottom bar both render this list. */
export const navItems = (view: View): NavItem[] => [
	{ label: 'Home', href: pathOf(view, 'home'), icon: HomeIcon, page: 'home' },
	{
		label: 'Recordings',
		href: pathOf(view, 'recordings'),
		icon: ListIcon,
		page: 'recordings',
	},
	{
		label: 'Transformations',
		href: pathOf(view, 'transformations'),
		icon: WandSparklesIcon,
		page: 'transformations',
	},
];
