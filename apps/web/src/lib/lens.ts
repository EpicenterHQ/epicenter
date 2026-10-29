/**
 * The one lens a repository opens with: every installed app's collections
 * together, so moving between apps of one repository keeps its handle.
 * Two apps may claim the same files (a collection is a view, not a
 * permission: ADR-0694); `combineApps` refuses two apps that use one
 * collection name.
 */
import type { AppManifest } from '@epicenter/app';
import { type App, combineApps, type Definitions, type Repository } from '@epicenter/repository';

/** The repository the shell opens: every installed app's collections, and the plain file API. */
export type ShellRepository = Repository<Definitions>;

const made = new Map<string, App>();

/** Every app's collections as one app; throws when two apps name a collection alike. The same apps give the same lens. */
export function lensOf(manifests: readonly AppManifest[]): App {
	const key = manifests.map(({ hostname }) => hostname).join(' ');
	const known = made.get(key);
	if (known !== undefined) return known;
	const lens = combineApps(manifests.map(({ collections }) => collections));
	made.set(key, lens);
	return lens;
}
