import { openLocal } from '@epicenter/app/open';
import { fromData } from '@epicenter/svelte';
import { whisperingDefinition } from '../data.js';

export type LocalStore = Awaited<
	ReturnType<typeof openLocal<typeof whisperingDefinition>>
>;

/** Initialized once by admitted browser boot, before any Local consumer mounts. */
export let local: LocalStore;
let opening: Promise<LocalStore> | undefined;

/** Imports are inert, including SSR and stopped boot. Opening failures reach AppBoot. */
export function openLocalStore() {
	opening ??= openLocal(whisperingDefinition).then((store) => {
		local = fromData(store);
		return local;
	});
	return opening;
}
