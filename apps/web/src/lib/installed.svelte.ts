/** The apps installed in this browser, and the lens every repository opens with: theirs together. */
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type Bundle, bundleFor, FIRST_PARTY } from './catalog.js';
import { lensOf } from './lens.js';

/** An installed app, by the hostname that identifies it. */
export type InstalledApp = { hostname: string; name: string };

/** Every installed app, in the order installed. */
export const installedApps = (): readonly InstalledApp[] => FIRST_PARTY.map(({ manifest: { hostname, name } }) => ({ hostname, name }));

/** The bundle of the installed app at `hostname`; undefined when none is installed there. */
export const installedBundle = (hostname: string): Bundle | undefined =>
	installedApps().some((app) => app.hostname === hostname) ? bundleFor(hostname) : undefined;

/** Install the app at `hostname`. Only the bundles this shell carries install yet. */
export function install(hostname: string): Result<InstalledApp, string> {
	const bundle = bundleFor(hostname);
	if (bundle === undefined) return Err(`Installing an app from ${hostname} is not built yet: only Epicenter's own apps install.`);
	return Ok({ hostname, name: bundle.manifest.name });
}

/** The lens every repository opens with: every installed app's collections. */
export const installedLens = () => lensOf(installedApps().flatMap(({ hostname }) => installedBundle(hostname)?.manifest ?? []));
