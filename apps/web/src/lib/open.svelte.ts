/**
 * The repository the shell has open: one handle per address, made when its
 * page first mounts and closed when the person leaves the repository. Its
 * apps read it from context. Leaving lists any typing it could not save, for
 * the person to copy on whatever page they went to.
 */
import type { Unsaved } from '@epicenter/repository';
import { openBrowserRepository } from '@epicenter/repository/browser';
import { reactive } from '@epicenter/svelte/repository';
import { createContext, tick } from 'svelte';
import { headersOf, type Manifest } from './device.svelte.js';
import { installedLens } from './installed.svelte.js';
import type { ShellRepository } from './lens.js';

/** An open repository: its handle, its reads tracked (`reactive`), and the copy it opened. */
export type OpenRepository = { repo: ShellRepository; manifest: Manifest };

export const [getOpenRepository, setOpenRepository] = createContext<OpenRepository>();

/** Open `manifest`'s copy in this tab, with every installed app's collections. */
export const openRepository = (manifest: Manifest): OpenRepository => ({
	repo: reactive(openBrowserRepository({ app: installedLens(), replica: manifest.replica, headers: headersOf(manifest) })),
	manifest,
});

let left = $state.raw<{ name: string; drafts: Unsaved[] }[]>([]);

/** Typing that repositories closed without saving, for the person to copy. */
export const unsaved = {
	get current() {
		return left;
	},
	dismiss(index: number) {
		left = left.filter((_, at) => at !== index);
	},
};

/**
 * Close `open` once the views over it have gone: they close their editors
 * as they unmount, then the repository closes and lists what it could not
 * save.
 */
export async function closeRepository({ repo, manifest }: OpenRepository) {
	await tick();
	const drafts = repo.close();
	if (drafts.length > 0) left = [...left, { name: manifest.name, drafts }];
}
