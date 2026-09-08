import type { Account } from '@epicenter/auth';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import {
	createBrowserBlobRemote,
	createEpicenterClient,
} from '@epicenter/client';
import { isAppId } from '@epicenter/constants/app-id';
import { openAppData } from '@epicenter/data/browser';
import type { DataDefinition } from '@epicenter/data/definition';
import {
	createScopedSqlite,
	type DeviceSqliteOwner,
	type ScopedSqlite,
} from '@epicenter/device/owner';
import type { StorageScope } from '@epicenter/device/protocol';

export type AppSqlite = ScopedSqlite;
export type App<TDefinition extends DataDefinition> = Omit<
	ReturnType<typeof openAppData<TDefinition>>,
	'sqlite'
> & { readonly sqlite: AppSqlite | null };
export type AppBlobs = App<DataDefinition>['blobs'];
export type AccountIdentity = NonNullable<App<DataDefinition>['account']>;

export type Epicenter<TDefinition extends DataDefinition> = {
	readonly appId: string;
	openLocal(): App<TDefinition>;
	openAccount(account: Account): App<TDefinition>;
};

export function createEpicenter<const TDefinition extends DataDefinition>({
	appId,
	definition,
	sqlite,
}: {
	appId: string;
	definition: TDefinition;
	/** Runtime owner for named SQLite files. Omit until an app needs SQLite. */
	sqlite?: DeviceSqliteOwner;
}): Epicenter<TDefinition> {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	function open(account?: Account): App<TDefinition> {
		let scope: StorageScope;
		if (account === undefined) {
			scope = { kind: 'local' };
		} else {
			const authorityId = account.authorityId;
			if (authorityId === undefined) {
				throw new Error('The account has no stable authority identity.');
			}
			scope = {
				kind: 'account',
				authorityId,
				principalId: account.principalId,
			};
		}
		const local = createBrowserBlobStore({
			appId,
			principalId: account?.principalId ?? 'local',
			authorityId: account?.authorityId,
		});
		const scopedSqlite =
			sqlite === undefined
				? null
				: createScopedSqlite(sqlite, appId, () => scope);
		return openAppData(definition, {
			appId,
			account,
			blobs: {
				local,
				sources: createBrowserBlobSources(local),
				remote: account
					? createBrowserBlobRemote({
							local,
							client: createEpicenterClient({
								baseURL: account.baseURL,
								fetch: account.fetch,
							}),
						})
					: null,
			},
			sqlite: scopedSqlite,
		});
	}
	return Object.freeze({
		appId,
		openLocal: () => open(),
		openAccount: (account: Account) => open(account),
	});
}
