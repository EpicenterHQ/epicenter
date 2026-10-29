/**
 * The one lens a repository opens with: every installed app's collections
 * together, so moving between apps of one repository keeps its handle.
 * `defineApp` refuses two apps whose templates could claim one file, and
 * `lensOf` two apps that use one collection name.
 */
import type { AppManifest } from '@epicenter/app';
import { type App, type Definitions, defineApp, type Repository } from '@epicenter/repository';

/** The repository the shell opens: every installed app's collections, and the plain file API. */
export type ShellRepository = Repository<Definitions>;

const made = new Map<string, App>();

/** Every app's collections as one app; throws when two apps name a collection alike. The same apps give the same lens. */
export function lensOf(manifests: readonly AppManifest[]): App {
	const key = manifests.map(({ hostname }) => hostname).join(' ');
	const known = made.get(key);
	if (known !== undefined) return known;
	const merged: Definitions = {};
	const owners = new Map<string, string>();
	for (const { hostname, collections } of manifests)
		for (const [name, definition] of Object.entries(collections.definitions)) {
			const other = owners.get(name);
			if (other !== undefined) throw new Error(`The apps '${other}' and '${hostname}' both name a collection '${name}'`);
			owners.set(name, hostname);
			merged[name] = definition;
		}
	const lens = defineApp(merged);
	made.set(key, lens);
	return lens;
}
