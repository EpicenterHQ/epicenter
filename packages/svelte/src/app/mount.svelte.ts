/**
 * A Svelte root as an Epicenter app (`@epicenter/app`): `mountSvelte(Root)`
 * is the bundle's `mount`. The root gets the repository with its reads
 * tracked (`reactive`), its path, and `navigate`; a URL that changes under
 * it updates `path` in place, so the app keeps its controls and editors.
 *
 *     export const mount = mountSvelte<typeof manifest>(TodosApp);
 */
import type { AnyManifest, DefinitionsOf, Mount, Navigate } from '@epicenter/app';
import type { Repository } from '@epicenter/repository';
import { type Component, mount, unmount } from 'svelte';
import { reactive } from '../repository/index.js';
import AppFrame from './app-frame.svelte';

/** What a Svelte app's root is given. */
export type AppProps<TManifest extends AnyManifest> = {
	/** The open repository, its reads tracked. */
	repo: Repository<DefinitionsOf<TManifest>>;
	/** Where the app is in its own routes, from `/`. */
	path: string;
	navigate: Navigate;
};

/** The `mount` of an app whose root is `Root`. */
export function mountSvelte<TManifest extends AnyManifest>(Root: Component<AppProps<TManifest>>): Mount<TManifest> {
	return (element, { repo, path, navigate }) => {
		// Only the path changes; the repository stays one object, not a deep proxy of it.
		let current = $state(path);
		const tracked = reactive(repo);
		const props: AppProps<TManifest> = {
			repo: tracked,
			get path() {
				return current;
			},
			navigate,
		};
		const frame = mount(AppFrame<AppProps<TManifest>>, { target: element, props: { Root, props } });
		return {
			unmount: () => unmount(frame),
			setPath(next) {
				current = next;
			},
		};
	};
}
