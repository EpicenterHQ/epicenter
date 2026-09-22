import type { Account } from '@epicenter/auth';
import type { BlobStoreFailed } from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import { appClaimAddress } from '@epicenter/device/app-claim';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { acquireRemoteBlobs } from './blob-owner.js';
import { compileData, type DataDefinition } from './data/definition/index.js';
import {
	createStoreOverPort,
	type DeclaredData,
	StoreError,
} from './data/store/store.js';
import { indexedDbStoreRuntime } from './platform/documents.js';

import type { StoreOwner, StoreRuntime } from './store-runtime.js';

export type { StoreOwner, StoreRuntime } from './store-runtime.js';

/** Local belongs to this device, regardless of the signed-in account. */
export async function openLocal<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	{ runtime = indexedDbStoreRuntime }: { runtime?: StoreRuntime } = {},
) {
	const id = definition.id;
	return Object.freeze(
		await openStore(definition, { kind: 'local' }, runtime, (assertUsable) =>
			runtime.localBlobs(id, assertUsable),
		),
	);
}

/** Personal captures identity and transport together before any asynchronous work. */
export async function openPersonal<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	{
		account,
		runtime = indexedDbStoreRuntime,
	}: { account: Account; runtime?: StoreRuntime },
) {
	const id = definition.id;
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
		async (assertUsable) =>
			Ok(await acquireRemoteBlobs({ id, account: captured, assertUsable })),
	);
	return Object.freeze(store);
}

const log = createLogger('app/store');

/** The engine owns cleanup; this boundary owns exclusion until cleanup is proven. */
async function openStore<const TDefinition extends DataDefinition, TBlobs>(
	definition: TDefinition,
	owner: StoreOwner,
	runtime: StoreRuntime,
	acquireBlobs: (
		assertUsable: () => void,
	) => Promise<
		Result<{ value: TBlobs; close(): Promise<void> }, BlobStoreFailed>
	>,
) {
	if (!isAppId(definition.id))
		throw new Error(`The application id '${definition.id}' is not valid.`);
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
	let blobs: { value: TBlobs; close(): Promise<void> } | undefined;
	let blobClosing: Promise<void> | undefined;
	function closeBlobs() {
		if (!blobs) return;
		return (blobClosing ??= (async () => blobs.close())());
	}
	const blobAcquisition = Promise.resolve()
		.then(() =>
			acquireBlobs(() => {
				if (closing) throw new Error('Store is closed.');
				document.lifetime.signal.throwIfAborted();
			}),
		)
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
	void blobAcquisition.catch(() => {});
	let closing: Promise<void> | undefined;
	function close(): Promise<void> {
		if (closing) return closing;
		const completion = Promise.withResolvers<void>();
		closing = completion.promise;
		// Both gates close before either cleanup is awaited.
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
			await blobAcquisition.catch(() => {});
			try {
				await closeBlobs();
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
		const [, acquired] = await Promise.all([
			document.ready.then((ready) => {
				if (ready.error) throw ready.error;
			}),
			blobAcquisition.then((result) => {
				if (result.error) throw result.error;
				return result.data;
			}),
		]);
		if (document.lifetime.signal.aborted)
			throw StoreError.ClosedWhileOpening().error;
		return Object.assign(
			document.store,
			document.view as DeclaredData<TDefinition>,
			{
				blobs: acquired.value,
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
