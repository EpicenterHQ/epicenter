/**
 * Which installed apps the Folders window offers on each folder (ADR-0537,
 * ADR-0552, ADR-0560).
 *
 * Every installed app that can run is offered on every data folder, as "Open
 * in" or "Open with". An installed app (ADR-0540) opens the folder it is handed
 * at launch through its definition (ADR-0538), which refuses a folder whose
 * declaration lacks what the app reads and names the folder. An app waiting
 * for approval, or broken, is not offered.
 *
 * Every installed app is also listed under Apps, where opening it hands it its
 * own folder.
 */

import type { InstalledApp } from '@epicenter/cli';

/** An app to open: its id, its title, and the commit listed for it. */
export type Opener = Pick<InstalledApp, 'id' | 'title' | 'commit'>;

/**
 * The installed apps that can run, by title: those built at their commit,
 * and those whose commit may run and builds when opened.
 */
export function installedOpeners(apps: readonly InstalledApp[]): Opener[] {
	return apps
		.filter(({ state }) => state.kind === 'ready' || state.kind === 'unbuilt')
		.map(({ id, title, commit }) => ({ id, title, commit }))
		.sort((a, b) => a.title.localeCompare(b.title));
}
