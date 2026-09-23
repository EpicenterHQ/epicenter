import type { Account } from '@epicenter/auth';
import type { BlobStoreFailed } from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import { appClaimAddress } from '@epicenter/device/app-claim';
import type { SqliteLifetime } from '@epicenter/device/owner';
import { createLogger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import { compileData, type DataDefinition } from './data/definition/index.js';
import {
	createStoreOverPort,
	type DeclaredData,
	StoreError,
} from './data/store/store.js';
import { indexedDbStoreRuntime } from './platform/documents.js';
import { borrowSqlite } from './sqlite.js';
import type { StoreOwner, StoreRuntime } from './store-runtime.js';

export type { StoreOwner, StoreRuntime } from './store-runtime.js';

/** Local belongs to this device, regardless of the signed-in account. */
export async function openLocal<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	{ runtime = indexedDbStoreRuntime }: { runtime?: StoreRuntime } = {},
) {
	const id = definition.id;
	const store = await openStore(
		definition,
		{ kind: 'local' },
		runtime,
		(assertUsable) => runtime.localBlobs(id, assertUsable),
	);
	if (!store.blobs) throw new Error('Local blob acquisition was absent.');
	return Object.freeze(Object.assign(store, { blobs: store.blobs }));
}

/** Personal captures identity and transport together before any asynchronous work. */
export async function openPersonal<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	{
		account,
		runtime = indexedDbStoreRuntime,
	}: { account: Account; runtime?: StoreRuntime },
) {
	const captured = Object.freeze({
		authorityId: account.authorityId,
		principalId: account.principalId,
		baseURL: account.baseURL,
		fetch: account.fetch,
		getProfile: account.getProfile,
		openWebSocket: account.openWebSocket,
	});
	const store = await openStore(
		definition,
		{ kind: 'personal', account: captured },
		runtime,
	);
	return Object.freeze(store);
}

const log = createLogger('app/store');

/** The engine owns cleanup; this boundary owns exclusion until cleanup is proven. */
async function openStore<const TDefinition extends DataDefinition, TBlobs = undefined>(
	definition: TDefinition,
	owner: StoreOwner,
	runtime: StoreRuntime,
	acquireBlobs?: (
		assertUsable: () => void,
	) => Promise<
		Result<{ value: TBlobs; close(): Promise<void> }, BlobStoreFailed>
	>,
) {
	if (!isAppId(definition.id))
		throw new Error(`The store definition ID '${definition.id}' is not valid.`);
	const parsed = compileData(definition);
	if (parsed.error)
		throw new Error(parsed.error.message, { cause: parsed.error });
	const ownership = await runtime.claim(
		appClaimAddress(
			definition.id,
			owner.kind === 'personal' ? owner.account : undefined,
		),
	);
	if (ownership.error) throw ownership.error;
	const claim = ownership.data;
	const acquisitionFailures: unknown[] = [];
	const document = createStoreOverPort({
		definition: parsed.data,
		local: owner.kind === 'local',
		async acquire() {
			try {
				return await runtime.data(parsed.data, owner);
			} catch (cause) {
				acquisitionFailures.push(cause);
				throw cause;
			}
		},
	});
	let closing: Promise<void> | undefined;
	function assertUsable() {
		if (closing) throw new Error('Store is closed.');
		document.lifetime.signal.throwIfAborted();
	}
	let sqlite: SqliteLifetime | undefined;
	let sqlClosing: Promise<void> | undefined;
	function closeSqlite() {
		if (!sqlite) return;
		return (sqlClosing ??= (async () => sqlite.close())());
	}
	// SQL crosses worker/native transports; never pass Account methods to that boundary.
	const sqlAcquisition = Promise.resolve()
		.then(() =>
			runtime.sqlite(
				definition.id,
				owner.kind === 'personal'
					? {
							authorityId: owner.account.authorityId,
							principalId: owner.account.principalId,
						}
					: undefined,
			),
		)
		.then(
			(acquired) => {
				sqlite = acquired;
				if (closing) void closeSqlite()?.catch(() => {});
				return acquired;
			},
			(cause) => {
				acquisitionFailures.push(cause);
				throw cause;
			},
		);
	void sqlAcquisition.catch(() => {});
	let blobs: { value: TBlobs; close(): Promise<void> } | undefined;
	let blobClosing: Promise<void> | undefined;
	function closeBlobs() {
		if (!blobs) return;
		return (blobClosing ??= (async () => blobs.close())());
	}
	const blobAcquisition = acquireBlobs && Promise.resolve()
		.then(() => acquireBlobs(assertUsable))
		.then(
			(acquired) => {
				if (acquired.error) return acquired;
				blobs = acquired.data;
				if (closing) void closeBlobs()?.catch(() => {});
				return acquired;
			},
			(cause) => {
				acquisitionFailures.push(cause);
				throw cause;
			},
		);
	void blobAcquisition?.catch(() => {});
	function close(): Promise<void> {
		if (closing) return closing;
		const completion = Promise.withResolvers<void>();
		closing = completion.promise;
		// Fence physical SQL before document abort listeners can use retained connections.
		closeSqlite();
		void sqlClosing?.catch(() => {});
		const documentClosing = document.close();
		closeBlobs();
		void documentClosing.catch(() => {});
		void blobClosing?.catch(() => {});
		void (async () => {
			const failures: unknown[] = [];
			try {
				await documentClosing;
			} catch (cause) {
				failures.push(cause);
			}
			await blobAcquisition?.catch(() => {});
			try {
				await closeBlobs();
			} catch (cause) {
				failures.push(cause);
			}
			await sqlAcquisition.catch(() => {});
			try {
				await closeSqlite();
			} catch (cause) {
				failures.push(cause);
			}
			// Every acquisition has settled before releasing the claim.
			failures.push(...acquisitionFailures);
			if (failures.length === 1) throw failures[0];
			if (failures.length)
				throw new AggregateError(failures, 'Store cleanup failed.');
			claim.release();
		})().then(completion.resolve, completion.reject);
		return closing;
	}
	document.lifetime.signal.addEventListener(
		'abort',
		() => {
			if (closing) return;
			void close().catch((cause) =>
				log.error(new Error('Store cleanup failed.', { cause })),
			);
		},
		{ once: true },
	);
	try {
		const [, acquired, sql] = await Promise.all([
			document.ready.then((ready) => {
				if (ready.error) throw ready.error;
			}),
			blobAcquisition?.then((result) => {
				if (result.error) throw result.error;
				return result.data;
			}),
			sqlAcquisition,
		]);
		if (document.lifetime.signal.aborted)
			throw StoreError.ClosedWhileOpening().error;
		return Object.assign(
			document.store,
			document.view as DeclaredData<TDefinition>,
			{
				...(acquired ? { blobs: acquired.value } : {}),
				sqlite: borrowSqlite(sql, assertUsable),
				signal: document.lifetime.signal,
				close,
			},
		);
	} catch (cause) {
		try {
			await close();
		} catch (cleanup) {
			throw new AggregateError(
				[cause, cleanup],
				'Store opening and cleanup failed.',
				{ cause },
			);
		}
		throw cause;
	}
}

export type LocalStore<TDefinition extends DataDefinition> = Awaited<
	ReturnType<typeof openLocal<TDefinition>>
>;
export type PersonalStore<TDefinition extends DataDefinition> = Awaited<
	ReturnType<typeof openPersonal<TDefinition>>
>;
