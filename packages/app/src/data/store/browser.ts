/**
 * Current-library and device storage for an App.
 * The page owns its live Yjs document; IndexedDB keeps its durable update log.
 * Opening never discovers, migrates, or deletes historical numbered caches.
 */
import type { ParsedDataDefinition } from '@epicenter/app/definition';
import { isAppId } from '@epicenter/constants/app-id';
import {
	type AccountIdentity,
	deviceOwnerPath,
	type PrincipalId,
} from '@epicenter/principal';
import { readCurrentDownload } from '@epicenter/sync/current-download';
import { CURRENT_ROUTE } from '@epicenter/sync/generations-route';
import * as Y from '@y/y';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import { openCurrentCache } from './current-cache.js';
import { createDatabaseDocument } from './document.js';
import type { DatabaseAccount } from './handles.js';
import {
	createIdbUpdates,
	type IdbRealm,
	idbTransactionDone,
	openIdbDatabase,
	readIdbUpdates,
} from './idb-updates.js';
import type { DurablePort, DurableSnapshot } from './persistence.js';
import { type StoreBacking, StoreError } from './store.js';

const UPDATES_STORE = 'updates';

export type BrowserBacking = {
	port: DurablePort;
	loaded: DurableSnapshot;
	/**
	 * Bring this address into being: one whole state and its position, in ONE
	 * transaction.
	 *
	 * A separate verb rather than a `DurableOp`, because it is not one. The
	 * port is the seam two engines implement (`port-conformance.test.ts`), and
	 * what both promise is that a generation is created whole.
	 *
	 * It does NOT check that the address is empty, and that is deliberate: the
	 * local opener checks `loaded.updates.length` under the App's claim.
	 */
	create(record: { bytes: Uint8Array; position: number }): Promise<void>;
	close(): void;
};

/**
 * This address's durable record, as a `DurablePort` over IndexedDB.
 *
 * Exported for the same reason `createSqliteDurablePort` is: the port is the
 * seam, and there are two implementations of it. One conformance suite drives
 * both through identical batches and holds them to identical results
 * (`port-conformance.test.ts`). Two suites that each check one implementation
 * against its own expectations is how the two came to disagree about the fold,
 * the identity stamp, and what a duplicate key does.
 *
 * Returns a port and loaded state. App construction owns the document.
 */
export async function openIdbBacking(
	address: string,
	idb: IdbRealm,
): Promise<Result<BrowserBacking, StoreError>> {
	const opened = await tryAsync({
		try: () => openIdbDatabase(address, [UPDATES_STORE], idb),
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (opened.error) return opened;
	const durable = opened.data;
	const result = await tryAsync({
		try: async () => {
			const read = durable.transaction(UPDATES_STORE, 'readonly');
			const [loaded] = await Promise.all([
				readIdbUpdates(read.objectStore(UPDATES_STORE)),
				idbTransactionDone(read),
			]);
			const { port, create } = createIdbUpdates(durable, loaded, idb);

			return { port, loaded, create, close: () => durable.close() };
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	// A returned failure proves the acquired connection was released. A cleanup
	// exception must escape so the caller keeps its library reservation.
	if (result.error) durable.close();
	return result;
}

/** A remote identity must remain exactly one durable address segment. */
function isSegment(value: string): boolean {
	return (
		value !== '' && !value.includes('/') && value !== '.' && value !== '..'
	);
}

/** Preserve the existing account-cache prefix; the selected library follows it. */
function accountCachePrefix(
	appId: string,
	principalId: PrincipalId,
	dataId: string,
	authorityId: string,
): Result<string, StoreError> {
	if (!isAppId(appId))
		return StoreError.Unaddressable({
			reason: `'${appId}' is not an application id`,
		});
	if (!isSegment(principalId))
		return StoreError.Unaddressable({
			reason: `'${principalId}' is not an address segment`,
		});
	if (!isSegment(authorityId))
		return StoreError.Unaddressable({
			reason: `'${authorityId}' is not an address segment`,
		});
	return Ok(
		`epicenter/${appId}/accounts/${authorityId}/${principalId}/data/${dataId}/`,
	);
}

/** The device library retains its original address, including its fixed final segment. */
async function acquireLocalData(
	definition: ParsedDataDefinition,
	appId: string,
	idb: IdbRealm,
	account?: AccountIdentity,
): Promise<Result<StoreBacking, StoreError>> {
	if (!isAppId(appId))
		return StoreError.Unaddressable({
			reason: `'${appId}' is not an application id`,
		});
	const address = `epicenter/${appId}/device/${deviceOwnerPath(account)}/data/${definition.id}/1`;
	const opened = await openIdbBacking(address, idb);
	if (opened.error) return opened;
	let backing = opened.data;
	if (backing.loaded.updates.length === 0) {
		const seed = createDatabaseDocument();
		const bytes = new Uint8Array(Y.encodeStateAsUpdateV2(seed));
		seed.destroy();
		const written = await tryAsync({
			try: () => backing.create({ bytes, position: 0 }),
			catch: (cause) => StoreError.StorageFailed({ cause }),
		});
		// A cleanup failure escapes: App must retain its ownership claim.
		backing.close();
		if (written.error) return written;
		// Hydrate exactly what the next boot would read.
		const reopened = await openIdbBacking(address, idb);
		if (reopened.error) return reopened;
		backing = reopened.data;
	}
	const held = backing;
	return Ok({ durable: held.port, loaded: held.loaded, dispose: held.close });
}

/** Capture ownership and transport together before asynchronous discovery. */
function captureAccount(account: DatabaseAccount): DatabaseAccount {
	return Object.freeze({
		authorityId: account.authorityId,
		principalId: account.principalId,
		baseURL: account.baseURL,
		fetch: account.fetch,
		openWebSocket: account.openWebSocket,
	});
}

export type AppDataScope = { appId: string } & (
	| { library: 'local'; account?: AccountIdentity }
	| { library: 'personal' | 'shared'; account: DatabaseAccount }
);

/** Acquire storage under the caller's exclusive App admission. */
export async function acquireAppData(
	definition: ParsedDataDefinition,
	options: AppDataScope,
	idb: IdbRealm,
): Promise<Result<StoreBacking, StoreError>> {
	const { appId } = options;
	if (options.library === 'local')
		return acquireLocalData(definition, appId, idb, options.account);
	const { library } = options;
	const account = captureAccount(options.account);
	const prefix = accountCachePrefix(
		appId,
		account.principalId,
		definition.id,
		account.authorityId,
	);
	if (prefix.error) return prefix;
	// A stable name per actor and selected library; generations live in its header.
	const address = `${prefix.data}${library}/current`;
	const opened = await openCurrentCache(address, idb);
	if (opened.error) return opened;
	const cache = opened.data;
	try {
		let loaded = cache.loaded;
		if (loaded === undefined) {
			const seed = createDatabaseDocument();
			const body = new Uint8Array(Y.encodeStateAsUpdateV2(seed));
			seed.destroy();
			const response = await account.fetch(
				CURRENT_ROUTE.url(account.baseURL, appId, library, definition.id),
				{
					method: 'POST',
					headers: { 'content-type': 'application/octet-stream' },
					body,
				},
			);
			const {
				generation,
				head,
				snapshot: baseline,
				tail,
			} = await readCurrentDownload(response);
			// Reconstruct the captured head before publishing a usable cache.
			const validation = createDatabaseDocument();
			let bytes: Uint8Array;
			try {
				Y.applyUpdateV2(validation, baseline.bytes);
				for (const entry of tail) Y.applyUpdateV2(validation, entry.bytes);
				if (
					validation.store.pendingStructs !== null ||
					validation.store.pendingDs !== null
				)
					throw new Error(
						'Current library download has unresolved Yjs dependencies',
					);
				bytes = Y.encodeStateAsUpdateV2(validation);
			} finally {
				validation.destroy();
			}
			const snapshot = await cache.install({
				generation,
				bytes,
				position: head,
			});
			loaded = { generation, snapshot };
		}
		return Ok({
			durable: cache.port,
			loaded: loaded.snapshot,
			discard: cache.discard,
			dispose: cache.close,
			replication: {
				address: {
					baseURL: account.baseURL,
					appId,
					library,
					dataId: definition.id,
					generation: loaded.generation,
				},
				transport: account,
			},
		});
	} catch (cause) {
		cache.close();
		return StoreError.StorageFailed({ cause });
	}
}
