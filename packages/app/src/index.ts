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
export type AccountIdentity = NonNullable<App<DataDefinition>['account']>;

export type AppBlobComposition = {
	local: BlobStore;
	sources: BlobSources;
	remote: BlobRemote;
};

export type AppBlobFactory = (input: {
	appId: string;
	account: Account | undefined;
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
	function open(account?: Account): App<TDefinition> {
		const authorityId = account?.authorityId;
		if (account !== undefined && authorityId === undefined) {
			throw new Error('The account has no stable authority identity.');
		}
		const blobComposition = blobs({ appId, account });
		const dataAccount =
			account !== undefined && authorityId !== undefined
				? { ...account, authorityId }
				: undefined;
		return openAppData(definition, {
			appId,
			account: dataAccount,
			blobs: blobComposition,
			sqlite,
		});
	}
	return Object.freeze({
		appId,
		openLocal: () => open(),
		openAccount: (account: Account) => open(account),
	});
}
