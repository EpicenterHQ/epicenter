import type { Account } from '@epicenter/auth';
import type { BlobRemote, BlobSources, BlobStore } from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import { openAppData } from '@epicenter/data/browser';
import type { DataDefinition } from '@epicenter/data/definition';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';

export type App<TDefinition extends DataDefinition> = ReturnType<
	typeof openAppData<TDefinition>
>;
export type AppSqlite = App<DataDefinition>['sqlite'];
export type AppBlobs = App<DataDefinition>['blobs'];

export type AppBlobComposition = {
	local: BlobStore;
	sources: BlobSources;
	remote: BlobRemote | null;
};

export type AppBlobFactory = (input: {
	appId: string;
	account: Account | null;
}) => AppBlobComposition;

export type Epicenter<TDefinition extends DataDefinition> = {
	readonly appId: string;
	openLocal(): App<TDefinition>;
	openAccount(account: Account): App<TDefinition>;
};

export function createEpicenter<const TDefinition extends DataDefinition>({
	appId,
	definition,
	sqlite,
	blobs,
}: {
	appId: string;
	definition: TDefinition;
	/** Runtime owner for this app's named SQLite files. */
	sqlite: DeviceSqliteOwner;
	/** Platform-owned blob capabilities for this app's storage root. */
	blobs: AppBlobFactory;
}): Epicenter<TDefinition> {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	function open(input: Account | null): App<TDefinition> {
		// Bind every capability before asynchronous acquisition can observe a
		// caller changing the supplied object. Transport closures retain retirement.
		const account =
			input === null
				? null
				: Object.freeze({
						authorityId: input.authorityId,
						principalId: input.principalId,
						baseURL: input.baseURL,
						fetch: input.fetch,
						openWebSocket: input.openWebSocket,
						getProfile: input.getProfile,
					});
		const blobComposition = blobs({ appId, account });
		return openAppData(definition, {
			appId,
			account,
			blobs: blobComposition,
			sqlite,
		});
	}
	return Object.freeze({
		appId,
		openLocal: () => open(null),
		openAccount: (account: Account) => open(account),
	});
}
