import { createAppBlobs } from '@epicenter/blobs/app';
import type { Account } from '@epicenter/auth';
import { isAppId } from '@epicenter/constants/app-id';
import { acquireAppData } from '@epicenter/data/browser';
import { compileData, type DataDefinition } from '@epicenter/data/definition';
import {
	createStoreOverPort,
	type DeclaredData,
	StoreError,
} from '@epicenter/data/store';
import {
	createAppSqlite,
	type DeviceSqliteOwner,
} from '@epicenter/device/owner';
import type {
	RecordingFactory,
	RecordingOwner,
} from '@epicenter/recorder/recording';
import { createLogger } from 'wellcrafted/logger';
import { Err } from 'wellcrafted/result';
import { createAppAi } from './ai.js';
import type { AppAiBinding, AppBlobFactory } from './index.js';
import type { resources } from '#platform/resources';

const log = createLogger('app');

/** Construct one fixed App; its caller owns when to await close. */
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	{
		appId,
		account: input,
		sqlite,
		blobs,
		recording,
		secrets,
		ai,
	}: {
		appId: string;
		account: Account | null;
		sqlite: DeviceSqliteOwner;
		blobs: AppBlobFactory;
		recording: RecordingFactory;
		secrets: typeof resources.secrets;
		ai?: AppAiBinding;
	},
) {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	const parsed = compileData(definition);
	if (parsed.error)
		throw new Error(parsed.error.message, { cause: parsed.error });
	if (input !== null && input.authorityId === undefined)
		throw new Error('The account has no stable authority identity.');
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
	const identity =
		account === null
			? null
			: Object.freeze({
					authorityId: account.authorityId,
					principalId: account.principalId,
				});
	const bytes = blobs({ appId, account });
	const databases = createAppSqlite(sqlite, appId, identity, {
		assertUsable(): void {
			document.lifetime.assertUsable();
		},
	});
	const acquisition = Promise.withResolvers<void>();
	let acquired = false;
	let dataReleased = true;
	const document = createStoreOverPort({
		definition: parsed.data,
		blobStore: bytes.local,
		local: account === null,
		async acquire() {
			try {
				const owned = await databases.acquire();
				if (owned.error) {
					const error = owned.error;
					return error.name === 'AlreadyOpen' ||
						error.name === 'LocksUnsupported' ||
						error.name === 'ClaimFailed'
						? Err(error)
						: StoreError.StorageFailed({ cause: error });
				}
				acquired = true;
				dataReleased = false;
				const opened = await acquireAppData(parsed.data, { appId, account });
				if (opened.error) {
					dataReleased = true;
					return opened;
				}
				return {
					...opened,
					data: {
						...opened.data,
						async dispose() {
							await opened.data.dispose?.();
							dataReleased = true;
						},
					},
				};
			} finally {
				acquisition.resolve();
			}
		},
	});
	let blobAccess: ReturnType<typeof createAppBlobs> | undefined;
	let secretAccess: ReturnType<typeof resources.secrets> | undefined;
	let recorder: RecordingOwner | undefined;
	let inference: ReturnType<typeof createAppAi> | undefined;
	let closing: Promise<void> | undefined;
	/** Stop resources once, retaining library ownership if a release fails. */
	function close(): Promise<void> {
		if (closing) return closing;
		const completion = Promise.withResolvers<void>();
		closing = completion.promise;
		// Document close revokes admission synchronously, including retained methods.
		const documentClosed = document.close();
		void (async () => {
			const results = await Promise.allSettled([
				documentClosed,
				Promise.resolve().then(() => databases.drain()),
				Promise.resolve().then(() => blobAccess?.close()),
				Promise.resolve().then(() => secretAccess?.close()),
				Promise.resolve().then(() => inference?.close()),
				acquisition.promise.then(() => recorder?.close()),
			]);
			const failures = results.filter((result) => result.status === 'rejected');
			// A reported callback failure can coexist with confirmed physical release.
			if (
				dataReleased &&
				results.slice(1).every((result) => result.status === 'fulfilled')
			) {
				try {
					await databases.close();
				} catch (reason) {
					failures.push({ status: 'rejected', reason });
				}
			}
			if (failures.length === 1) throw failures[0]!.reason;
			if (failures.length > 1)
				throw new AggregateError(
					failures.map((result) => result.reason),
					'Application cleanup failed.',
				);
		})().then(completion.resolve, (cause) => {
			if (document.isRetired && !dataReleased) closing = undefined;
			completion.reject(cause);
		});
		return closing;
	}
	const ready = document.ready.then(async (result) => {
		if (document.isRetired) return StoreError.ClosedWhileOpening();
		if (result.error)
			await close().catch((cause) =>
				log.error(
					new Error('Application cleanup failed after opening failed.', {
						cause,
					}),
				),
			);
		return result;
	});
	try {
		blobAccess = createAppBlobs({
			...bytes,
			assertUsable: document.lifetime.assertUsable,
		});
		recorder = recording(appId, identity, {
			assertUsable: document.lifetime.assertUsable,
			canRecover: () => acquired,
		});
		// Capture must stop while cache invalidation is still pending. The owner
		// retains a failed close; final App closure observes it before releasing
		// the library claim. This callback does not close the data backing.
		void document.retirement.then(() => recorder?.close()).catch(() => {});
		inference = createAppAi({
			lifetime: document.lifetime,
			account: account === null ? null : (ai?.account?.(account) ?? null),
			runtime: ai?.runtime ?? null,
			configuration: ai?.configuration?.(appId) ?? null,
			configuredFetch: ai?.configuredFetch,
		});
		secretAccess = secrets(appId, identity, {
			assertUsable: document.lifetime.assertUsable,
		});
		return Object.freeze(
			Object.assign(
				document.store,
				document.view as DeclaredData<TDefinition>,
				{
					appId,
					dataId: parsed.data.id,
					account: identity,
					ready,
					retirement: document.retirement,
					close,
					blobs: blobAccess.value,
					sqlite: databases.value,
					secrets: secretAccess.value,
					recording: recorder.value,
					ai: inference.value.ai,
				},
			),
		);
	} catch (cause) {
		void close().catch((error) =>
			log.error(
				new Error('Application construction cleanup failed.', { cause: error }),
			),
		);
		throw cause;
	}
}
