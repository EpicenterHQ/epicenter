import type { Account } from '@epicenter/auth';
import type {
	BlobAttachment,
	BlobRemote,
	BlobSources,
	BlobStore,
} from '@epicenter/blobs';
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
	ReturnType<typeof openAppData<TDefinition, AppSqlite>>,
	'sqlite'
> & { readonly sqlite: AppSqlite };
export type AppBlobs = App<DataDefinition>['blobs'];
export type AccountIdentity = NonNullable<App<DataDefinition>['account']>;

export type AppBlobComposition = {
	local: BlobStore;
	sources: BlobSources;
	remote: BlobRemote | null;
};

export type AppBlobFactory = (input: {
	appId: string;
	account: Account | undefined;
}) => AppBlobComposition;
export type AppBlobAttachment = BlobAttachment;

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
		const blobComposition = blobs({ appId, account });
		const dataAccount =
			account === undefined
				? undefined
				: (() => {
						if (scope.kind !== 'account')
							throw new Error('An account must open an account-scoped store.');
						return { ...account, authorityId: scope.authorityId };
					})();
		const sqliteState = { ready: false, closed: false };
		const sqliteOperations = new Set<Promise<unknown>>();
		const trackSqliteOperation = <T>(operation: () => Promise<T>): Promise<T> => {
			// Queue invocation behind admission. The operation may synchronously
			// re-enter app.close(), so invoking it before adding its promise would
			// let close observe an incomplete set.
			const pending = Promise.resolve().then(operation);
			sqliteOperations.add(pending);
			void pending.then(
				() => sqliteOperations.delete(pending),
				() => sqliteOperations.delete(pending),
			);
			return pending;
		};
		const scopedSqlite = createScopedSqlite(
			sqlite,
			appId,
			scope,
			() => {
				if (sqliteState.closed) throw new Error('The app is disposed.');
				if (!sqliteState.ready) throw new Error('The app is not ready.');
			},
			trackSqliteOperation,
		);
		const opened = openAppData(definition, {
			appId,
			account: dataAccount,
			blobs: blobComposition,
			sqlite: scopedSqlite,
			onClose: () => {
				sqliteState.closed = true;
			},
			beforeClose: async () => {
				await Promise.allSettled(sqliteOperations);
			},
		});
		void opened.ready.then((result) => {
			if (result.error === null) sqliteState.ready = true;
		});
		return opened;
	}
	return Object.freeze({
		appId,
		openLocal: () => open(),
		openAccount: (account: Account) => open(account),
	});
}
