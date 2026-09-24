import { openLocal } from '@epicenter/app/open';
import { fromData } from '@epicenter/svelte';
import { createLogger } from 'wellcrafted/logger';
import { whisperingDefinition } from '../data.js';
import { migrateLocalTranscriptions } from './migrate-local-transcriptions.js';

const log = createLogger('whispering/local');

export type LocalStore = Awaited<
	ReturnType<typeof openLocal<typeof whisperingDefinition>>
>;

/** Initialized once by the working layout, before any Local consumer mounts. */
export let local: LocalStore;
let opening: Promise<LocalStore> | undefined;

/** Imports are inert. Opening failures reach the working layout. */
export function openLocalStore() {
	opening ??= openLocal(whisperingDefinition).then(async (store) => {
		try {
			await migrateLocalTranscriptions(store);
			local = fromData(store);
			return local;
		} catch (cause) {
			await store.close().catch((closeError) => log.error(closeError));
			throw cause;
		}
	});
	return opening;
}
