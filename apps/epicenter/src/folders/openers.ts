/**
 * Which apps the Folders window offers (ADR-0537).
 *
 * Every app Epicenter bundles, Todos, Capture, Honeycrisp, and Whispering, is
 * listed under Apps, where opening it hands it its default folder, and is
 * offered on every data folder as "Open with". Each opens the folder it is
 * handed through the schema it supplies to Folder.
 */

import type { BundledApp } from '../ui/bindings.gen';

/** An app Epicenter bundles, by the page the shell names it by and its title. */
export type Opener = { app: BundledApp; title: string };

/**
 * Each app Epicenter bundles (`BundledApp` in `src-tauri/src/bundled_apps.rs`),
 * by title.
 */
const TITLES: Record<BundledApp, string> = {
	todos: 'Todos',
	capture: 'Capture',
	honeycrisp: 'Honeycrisp',
	whispering: 'Whispering',
};

/** The apps Epicenter bundles, by title. */
export const bundledOpeners: readonly Opener[] = (
	Object.entries(TITLES) as [BundledApp, string][]
)
	.map(([app, title]) => ({ app, title }))
	.sort((a, b) => a.title.localeCompare(b.title));
