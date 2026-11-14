import HomeIcon from '@lucide/svelte/icons/house';
import ListIcon from '@lucide/svelte/icons/list';
import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
import type { Component } from 'svelte';
import { resolve } from '$app/paths';

/** Whispering's pages. */
export type Page = 'home' | 'recordings' | 'transformations';

/** Every page's path. */
const PATHS = {
	home: resolve('/'),
	recordings: resolve('/recordings'),
	transformations: resolve('/transformations'),
} as const satisfies Record<Page, string>;

/** Page `page`'s path. */
export const pathOf = (page: Page): string => PATHS[page];

/** Trailing slashes aside, whether `pathname` is `href` or below it. */
const under = (href: string, pathname: string) =>
	pathname === href || pathname.startsWith(`${href}/`);

/** Which page `pathname` is. */
export function pageAt(pathname: string): Page {
	for (const page of ['recordings', 'transformations'] as const)
		if (under(PATHS[page], pathname)) return page;
	return 'home';
}

export type NavItem = {
	label: string;
	href: string;
	icon: Component;
	page: Page;
};

/** The pages, as the sidebar and the bottom bar both render them. */
export const NAV_ITEMS: readonly NavItem[] = [
	{ label: 'Home', href: pathOf('home'), icon: HomeIcon, page: 'home' },
	{
		label: 'Recordings',
		href: pathOf('recordings'),
		icon: ListIcon,
		page: 'recordings',
	},
	{
		label: 'Transformations',
		href: pathOf('transformations'),
		icon: WandSparklesIcon,
		page: 'transformations',
	},
];
