import { createEpicenter } from '@epicenter/app';
import { APPS } from '@epicenter/constants/apps';
import { appBlobs } from '#platform/app-blobs';
import { recording } from '#platform/recording';
import { sqlite } from '#platform/sqlite';
import { whisperingDefinition } from './data';

/**
 * Whispering's inert configuration. RecordingsSession calls openLocal() or
 * openAccount(account) and owns the returned App's readiness and closure.
 */
export const epicenter = createEpicenter({
	appId: APPS.WHISPERING.id,
	definition: whisperingDefinition,
	sqlite,
	blobs: appBlobs,
	recording,
});
