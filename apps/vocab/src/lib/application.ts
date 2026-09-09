import { createEpicenter } from '@epicenter/app';
import { createBrowserAppBlobs } from '@epicenter/app/browser';
import { createDeparture } from '@epicenter/app-shell/departure';
import { APPS } from '@epicenter/constants/apps';
import { sqlite } from '#platform/sqlite';
import { authClient } from './auth.js';
import { vocabDefinition } from './data.js';

// Imported only after the application route mounts. Module lifetime fixes
// both the Account and App across navigation in this document.
const state = authClient.state;
export const account = state.status === 'signed-out' ? null : state.account;
export const app =
	account === null || new URLSearchParams(location.search).has('connect')
		? null
		: createEpicenter({
				appId: APPS.VOCAB.id,
				definition: vocabDefinition,
				sqlite,
				blobs: createBrowserAppBlobs(),
			}).openAccount(account);
export const departure = createDeparture({
	retirement: app?.retirement,
	reload: () => location.reload(),
	auth: app ? authClient : undefined,
	account,
	close: () => app?.close() ?? Promise.resolve(),
});
