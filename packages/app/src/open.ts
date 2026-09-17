import type { Account } from '@epicenter/auth';
import { createAppBlobs, createAppRemoteBlobs } from '@epicenter/blobs/app';
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
	AccountIdentity,
	LibraryReplicaIdentity,
} from '@epicenter/principal';
import { CURRENT_ROUTE } from '@epicenter/sync/generations-route';
import { createLogger } from 'wellcrafted/logger';
import { Err } from 'wellcrafted/result';
import type { resources } from '#platform/resources';
import { createAppAi } from './ai.js';
import type { AppAiBinding, AppBlobFactory } from './index.js';
import type { RecordingFactory, RecordingOwner } from './recorder.js';

const log = createLogger('app');

type LibraryChoice =
	| { library: 'local' }
	| { library: 'personal' | 'shared'; account: Account };

type OpenOptions = {
	appId: string;
	sqlite: DeviceSqliteOwner;
	blobs: AppBlobFactory;
	recording: RecordingFactory;
	secrets: typeof resources.secrets;
	ai?: AppAiBinding;
};

/** Every fact the library choice fixes, derived once. */
function captureReplica(choice: LibraryChoice, appId: string, dataId: string) {
	if (choice.library === 'local')
		return {
			replica: { library: 'local' } as const satisfies LibraryReplicaIdentity,
			identity: null,
			remote: null,
		};
	const account = choice.account;
	const identity: AccountIdentity = Object.freeze({
		authorityId: account.authorityId,
		principalId: account.principalId,
	});
	const transport = Object.freeze({
		authorityId: account.authorityId,
		principalId: account.principalId,
		baseURL: account.baseURL,
		fetch: account.fetch,
		openWebSocket: account.openWebSocket,
		getProfile: account.getProfile,
	});
	return {
		replica: {
			library: choice.library,
			account: identity,
		} satisfies LibraryReplicaIdentity,
		identity,
		remote: {
			currentUrl: CURRENT_ROUTE.url(
				account.baseURL,
				appId,
				choice.library,
				dataId,
			),
			address: {
				baseURL: account.baseURL,
				appId,
				library: choice.library,
			},
			transport,
		},
	};
}

/** The opened handle, shaped by the open call: a local App has no account members. */
export type App<TDefinition extends DataDefinition> = ReturnType<
	typeof buildApp<TDefinition>
>;
export type LocalApp<TDefinition extends DataDefinition> = Extract<
	App<TDefinition>,
	{ library: 'local' }
>;
export type AccountApp<TDefinition extends DataDefinition> = Exclude<
	App<TDefinition>,
	{ library: 'local' }
>;

/** Construct one fixed App; its caller owns when to await close. */
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	options: OpenOptions & { choice: { library: 'local' } },
): LocalApp<TDefinition>;
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	options: OpenOptions & {
		choice: { library: 'personal' | 'shared'; account: Account };
	},
): AccountApp<TDefinition>;
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	options: OpenOptions & { choice: LibraryChoice },
): App<TDefinition> {
	return buildApp(definition, options);
}

function buildApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	{
		appId,
		choice,
		sqlite,
		blobs,
		recording,
		secrets,
		ai,
	}: OpenOptions & { choice: LibraryChoice },
) {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	const parsed = compileData(definition);
	if (parsed.error)
		throw new Error(parsed.error.message, { cause: parsed.error });
	const { replica, identity, remote } = captureReplica(
		choice,
		appId,
		parsed.data.id,
	);
	const bytes = blobs({
		appId,
		account: choice.library === 'local' ? null : choice.account,
	});
	if (choice.library !== 'local' && bytes.remote === null)
		throw new Error('An account App requires remote blob access.');
	const databases = createAppSqlite(sqlite, appId, replica, {
		assertUsable(): void {
			document.lifetime.assertUsable();
		},
	});
	let dataReleased = true;
	const document = createStoreOverPort({
		definition: parsed.data,
		local: identity === null,
		async acquire() {
			const owned = await databases.acquire();
			if (owned.error) {
				const error = owned.error;
				return error.name === 'AlreadyOpen' ||
					error.name === 'LocksUnsupported' ||
					error.name === 'ClaimFailed'
					? Err(error)
					: StoreError.StorageFailed({ cause: error });
			}
			dataReleased = false;
			const opened = await acquireAppData(parsed.data, {
				appId,
				replica,
				remote,
			});
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
		},
	});
	let blobAccess: ReturnType<typeof createAppBlobs> | undefined;
	let remoteBlobAccess: ReturnType<typeof createAppRemoteBlobs> | undefined;
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
				Promise.resolve().then(() => remoteBlobAccess?.close()),
				Promise.resolve().then(() => secretAccess?.close()),
				Promise.resolve().then(() => inference?.close()),
				// Recording owns admitted publication independently of public blob access.
				Promise.resolve().then(() => recorder?.close()),
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
	const ready = document.ready.then(async (opened) => {
		let result = opened;
		if (!result.error) {
			try {
				await inference?.ready;
			} catch (cause) {
				result = StoreError.StorageFailed({ cause });
			}
		}
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
		if (bytes.remote !== null)
			remoteBlobAccess = createAppRemoteBlobs({
				remote: bytes.remote,
				assertUsable: document.lifetime.assertUsable,
			});
		document.lifetime.signal.addEventListener(
			'abort',
			() => {
				void remoteBlobAccess?.close().catch((cause) =>
					log.error(
						new Error('Remote blob cleanup failed after App retirement.', {
							cause,
						}),
					),
				);
			},
			{ once: true },
		);
		recorder = recording(appId, {
			assertUsable: document.lifetime.assertUsable,
			write: (id, blob) => bytes.local.put(id, blob),
		});
		// Capture must stop while cache invalidation is still pending. The owner
		// retains a failed close; final App closure observes it before releasing
		// the library claim. This callback does not close the data backing.
		void document.retirement.then(() => recorder?.close()).catch(() => {});
		// The binding sees the captured snapshot, never the live Account.
		const accountTransport =
			remote === null ? null : (ai?.account?.(remote.transport) ?? null);
		inference = createAppAi({
			lifetime: document.lifetime,
			account:
				accountTransport && identity !== null
					? { ...accountTransport, identity }
					: null,
			runtime: ai?.runtime ?? null,
			connections: ai?.connections?.(appId) ?? null,
			configuredFetch: ai?.configuredFetch,
		});
		secretAccess = secrets(appId, identity, {
			assertUsable: document.lifetime.assertUsable,
		});
		const common = {
			appId,
			dataId: parsed.data.id,
			ready,
			/** Aborts synchronously when this App closes or its library is retired. */
			signal: document.lifetime.signal,
			close,
			sqlite: databases.value,
			secrets: secretAccess.value,
			recording: recorder.value,
			ai: inference.value.ai,
		};
		// One object, one owner: the store is extended in place, never spread.
		return Object.freeze(
			identity === null
				? Object.assign(
						document.store,
						document.view as DeclaredData<TDefinition>,
						common,
						{ library: 'local' as const, blobs: { local: blobAccess.value } },
					)
				: Object.assign(
						document.store,
						document.view as DeclaredData<TDefinition>,
						common,
						{
							library: replica.library as 'personal' | 'shared',
							blobs: {
								local: blobAccess.value,
								remote: remoteBlobAccess!.value,
							},
							account: identity,
							retirement: document.retirement,
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
