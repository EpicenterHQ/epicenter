import HomeIcon from '@lucide/svelte/icons/house';
import LayersIcon from '@lucide/svelte/icons/layers';
import ListIcon from '@lucide/svelte/icons/list';
import SettingsIcon from '@lucide/svelte/icons/settings';
import type { Component } from 'svelte';
import { base, resolve } from '$app/paths';

export type NavItem = {
	label: string;
	href: string;
	icon: Component;
	isActive: (pathname: string) => boolean;
};

/** Matches a route and all its sub-routes (e.g., `/settings` matches `/settings/audio`). */
const matchesRoute = (href: string) => (pathname: string) =>
	pathname === href || pathname.startsWith(`${href}/`);

/**
 * Primary navigation items shared across sidebar and bottom bar layouts.
 *
 * Add new top-level routes here: both `VerticalNav` and `BottomNav` consume
 * this array, so changes propagate automatically.
 */
export const NAV_ITEMS = [
	{
		label: 'Home',
		href: resolve('/'),
		icon: HomeIcon,
		isActive: (pathname) => pathname === base || pathname === resolve('/'),
	},
	{
		label: 'Recordings',
		href: resolve('/recordings'),
		icon: ListIcon,
		isActive: matchesRoute(resolve('/recordings')),
	},
	{
		label: 'Recipes',
		href: resolve('/recipes'),
		icon: LayersIcon,
		isActive: matchesRoute(resolve('/recipes')),
	},
	{
		label: 'Settings',
		href: resolve('/settings'),
		icon: SettingsIcon,
		isActive: matchesRoute(resolve('/settings')),
	},
] as const satisfies readonly NavItem[];
