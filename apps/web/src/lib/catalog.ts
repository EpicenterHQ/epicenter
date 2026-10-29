/**
 * The bundles this shell can install: the first-party apps, compiled in
 * (ADR-0694). Each is a manifest, read without loading the app, and its
 * module, loaded the first time it is mounted, so each app is a chunk of
 * its own. Installing an app from any other hostname is not built yet.
 */
import type { AnyManifest, AppManifest, AppModule } from '@epicenter/app';
import { manifest as files } from '@epicenter/files';
import { manifest as honeycrisp } from '@epicenter/honeycrisp';
import { manifest as todos } from '@epicenter/todos';

/** An app this shell can install: its manifest, its module (loaded when first mounted), and the hash an install pins. */
export type Bundle = { manifest: AppManifest; load(): Promise<AppModule>; hash: string };

/** A bundle, its collections erased: the shell mounts it over a repository opened with every installed app's collections, which include its own. */
function bundle<TManifest extends AnyManifest & Pick<AppManifest, 'name' | 'hostname'>>(manifest: TManifest, load: () => Promise<AppModule<TManifest>>, hash: string): Bundle {
	// SAFETY: `App` is invariant in its definitions, so a manifest's type does not widen on its own. The shell opens the repository with a lens
	// that holds this app's collections (`lensOf`), so the repository the app is given has every collection its type names.
	return { manifest, load, hash } as unknown as Bundle;
}

/**
 * The first-party bundles. Each is compiled into the shell, so its hash is
 * the SHA-256 of its package's source as this build compiled it
 * (`vite.config.ts`); a bundle served from its own hostname would be
 * pinned by the hash of the files served.
 */
export const FIRST_PARTY: readonly Bundle[] = [
	bundle(files, () => import('@epicenter/files/bundle'), __BUNDLE_HASHES__.files),
	bundle(todos, () => import('@epicenter/todos/bundle'), __BUNDLE_HASHES__.todos),
	bundle(honeycrisp, () => import('@epicenter/honeycrisp/bundle'), __BUNDLE_HASHES__.honeycrisp),
];

/** The bundle this shell has for `hostname`, if any. */
export const bundleFor = (hostname: string) => FIRST_PARTY.find((entry) => entry.manifest.hostname === hostname);

/** Files' hostname: the app any link falls back to when its own app is not installed. */
export const FILES = files.hostname;

/** What a new device starts with installed (ADR-0694). */
export const DEFAULT_APPS: readonly string[] = [files.hostname, todos.hostname, honeycrisp.hostname];
