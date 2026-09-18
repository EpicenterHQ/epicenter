import type { Account } from '@epicenter/auth';
import { createAppBlobs, createAppRemoteBlobs } from '@epicenter/blobs/app';
import { isAppId } from '@epicenter/constants/app-id';
import { resources } from '#platform/resources';

/** Use app-local storage without opening a data library; close releases display URLs. */
export function createLocalBlobs({ appId }: { appId: string }) {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	const bytes = resources.blobs({ appId });
	const owner = createAppBlobs(bytes);
	return Object.freeze({ ...owner.value, close: owner.close });
}

/** Use explicit hosting without opening a data library; close cancels admitted requests. */
export function createRemoteBlobs({
	appId,
	account,
}: {
	appId: string;
	account: Account;
}) {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	const bytes = resources.blobs({ appId, account });
	if (bytes.remote === null)
		throw new Error('Remote blob access requires an account.');
	const owner = createAppRemoteBlobs({ remote: bytes.remote });
	return Object.freeze({ ...owner.value, close: owner.close });
}
