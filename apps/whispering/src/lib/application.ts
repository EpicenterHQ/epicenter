import { createEpicenter } from '@epicenter/app';
import { createDeparture } from '@epicenter/app-shell/departure';
import { APPS } from '@epicenter/constants/apps';
import { appBlobs } from '#platform/app-blobs';
import { authClient } from '#platform/auth';
import { recording } from '#platform/recording';
import { sqlite } from '#platform/sqlite';
import { whisperingDefinition } from './data.js';

// The mounted application group imports this once; callbacks and overlays do not.
const auth = authClient.auth;
const state = auth?.state;
export const account = !state || state.status === 'signed-out' ? null : state.account;
const epicenter = createEpicenter({
	appId: APPS.WHISPERING.id,
	definition: whisperingDefinition,
	sqlite,
	blobs: appBlobs,
	recording,
});
export const app = auth === null || new URLSearchParams(location.search).has('connect')
	? null
	: account === null
		? epicenter.openLocal()
		: epicenter.openAccount(account);
export const departure = createDeparture({
	retirement: app?.retirement,
	reload: () => location.reload(),
	auth: app && auth ? auth : undefined,
	account,
	close: () => app?.close() ?? Promise.resolve(),
});
