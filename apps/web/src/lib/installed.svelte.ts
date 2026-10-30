/**
 * This browser's installed apps (`installed.ts`), kept in `localStorage`,
 * and the lens every repository opens with: their collections together.
 * Installing changes the lens, so an open repository opens again with it
 * (`installedKey`). Another tab's install shows here as it is made.
 */
import type { Result } from 'wellcrafted/result';
import { type Bundle, bundleFor, DEFAULT_APPS } from './catalog.js';
import { type InstalledApp, openInstalled, RECORD_KEY } from './installed.js';
import { lensOf } from './lens.js';

export type { InstalledApp };

const record = openInstalled({
	storage: localStorage,
	installable: (hostname) => {
		const bundle = bundleFor(hostname);
		return bundle === undefined
			? undefined
			: { name: bundle.manifest.name, hash: bundle.hash };
	},
	defaults: DEFAULT_APPS,
});

let apps = $state.raw(record.apps());

window.addEventListener('storage', (event) => {
	if (event.key !== RECORD_KEY) return;
	record.reload();
	apps = record.apps();
});

/** Every installed app, in the order installed. */
export const installedApps = (): readonly InstalledApp[] => apps;

/** The bundle of the installed app at `hostname`; undefined when none is installed there. */
export const installedBundle = (hostname: string): Bundle | undefined =>
	apps.some((app) => app.hostname === hostname)
		? bundleFor(hostname)
		: undefined;

/** Install the app at `hostname`, pinned to its hash. Only the bundles this shell carries install yet. */
export function install(hostname: string): Result<InstalledApp, string> {
	const installed = record.install(hostname);
	apps = record.apps();
	return installed;
}

/** What the lens depends on: an open repository opens again when it changes. */
export const installedKey = () =>
	apps.map(({ hostname }) => hostname).join(' ');

/** The lens every repository opens with: every installed app's collections. */
export const installedLens = () =>
	lensOf(apps.flatMap(({ hostname }) => bundleFor(hostname)?.manifest ?? []));
