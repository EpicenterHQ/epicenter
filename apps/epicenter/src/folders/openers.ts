/**
 * Which apps the Folders window offers on each folder (ADR-0537, ADR-0552,
 * ADR-0560).
 *
 * Every app Epicenter bundles, Todos, Capture, Honeycrisp, and Whispering, is
 * offered on every data folder, and so is every installed app that can run,
 * as "Open in" or "Open with". Each opens the folder it is handed through
 * the schema it supplies to Folder. An installed app waiting for approval,
 * or broken, is not offered.
 *
 * The bundled apps replace their installed copies: an installed app with a
 * bundled app's id is neither offered nor listed, so each of the four
 * appears once. Every app is also listed under Apps, where opening it hands
 * a bundled app its default folder and an installed app its own folder.
 */

import type { InstalledApp } from '@epicenter/cli';
import type { BundledApp } from '../ui/bindings.gen';

/** An app to open: one Epicenter bundles, or an installed app at the commit listed for it. */
export type Opener =
	| { kind: 'bundled'; app: BundledApp; id: string; title: string }
	| ({ kind: 'installed' } & Pick<InstalledApp, 'id' | 'title' | 'commit'>);

/**
 * Each app Epicenter bundles (`BundledApp` in `src-tauri/src/bundled_apps.rs`),
 * by its title and the id its installed copy has.
 */
const BUNDLED: Record<BundledApp, { title: string; id: string }> = {
	todos: { title: 'Todos', id: 'so.epicenter.todos' },
	capture: { title: 'Capture', id: 'so.epicenter.capture' },
	honeycrisp: { title: 'Honeycrisp', id: 'so.epicenter.honeycrisp' },
	whispering: { title: 'Whispering', id: 'so.epicenter.whispering' },
};

/** The apps Epicenter bundles, by title. */
export const bundledOpeners: readonly Opener[] = (
	Object.entries(BUNDLED) as [BundledApp, { title: string; id: string }][]
)
	.map(([app, { title, id }]) => ({ kind: 'bundled' as const, app, id, title }))
	.sort((a, b) => a.title.localeCompare(b.title));

const bundledIds = new Set(Object.values(BUNDLED).map(({ id }) => id));

/** The installed apps the window lists: every one but a bundled app's installed copy. */
export function listedInstalledApps(
	apps: readonly InstalledApp[],
): InstalledApp[] {
	return apps.filter(({ id }) => !bundledIds.has(id));
}

/**
 * The apps every folder offers, by title: each bundled app, and each listed
 * installed app with an approved commit, built or not. Opening an installed
 * app builds that commit first when it is not built.
 */
export function folderOpeners(apps: readonly InstalledApp[]): Opener[] {
	const installed: Opener[] = listedInstalledApps(apps)
		.filter(({ state }) => state.kind === 'ready' || state.kind === 'unbuilt')
		.map(({ id, title, commit }) => ({
			kind: 'installed' as const,
			id,
			title,
			commit,
		}));
	return [...bundledOpeners, ...installed].sort((a, b) =>
		a.title.localeCompare(b.title),
	);
}
