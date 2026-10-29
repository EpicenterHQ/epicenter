/**
 * The bundles this shell can install: the first-party apps, compiled in
 * (ADR-0694). Each is a manifest, read without loading the app, and its
 * module, loaded the first time it is mounted, so each app is a chunk of
 * its own. Installing an app from any other hostname is not built yet.
 */
import type { AnyManifest, AppManifest, AppModule } from '@epicenter/app';
import { manifest as honeycrisp } from '@epicenter/honeycrisp';
import { manifest as todos } from '@epicenter/todos';

/** An app this shell can install: its manifest, and its module, loaded when first mounted. */
export type Bundle = { manifest: AppManifest; load(): Promise<AppModule> };

/** A bundle, its collections erased: the shell mounts it over a repository opened with every installed app's collections, which include its own. */
function bundle<TManifest extends AnyManifest & Pick<AppManifest, 'name' | 'hostname'>>(manifest: TManifest, load: () => Promise<AppModule<TManifest>>): Bundle {
	// SAFETY: `App` is invariant in its definitions, so a manifest's type does not widen on its own. The shell opens the repository with a lens
	// that holds this app's collections (`lensOf`), so the repository the app is given has every collection its type names.
	return { manifest, load } as unknown as Bundle;
}

export const FIRST_PARTY: readonly Bundle[] = [
	bundle(todos, () => import('@epicenter/todos/bundle')),
	bundle(honeycrisp, () => import('@epicenter/honeycrisp/bundle')),
];

/** The bundle this shell has for `hostname`, if any. */
export const bundleFor = (hostname: string) => FIRST_PARTY.find((entry) => entry.manifest.hostname === hostname);

/** Files' hostname: the app any link falls back to when its own app is not installed. */
export const FILES = 'files.epicenter.so';
