import type { Account } from '@epicenter/auth';
import { createAppBlobs, createAppRemoteBlobs } from '@epicenter/blobs/app';
import { isAppId } from '@epicenter/constants/app-id';
import type { claimApp } from '@epicenter/device/library-claim';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { createAppSqlite } from '@epicenter/device/owner';
import type { AccountIdentity } from '@epicenter/principal';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { createAppAi } from './ai.js';
import type { ParsedDataDefinition } from './data/definition/index.js';
import { compileData, type DataDefinition } from './data/definition/index.js';
import type { AppDataScope } from './data/store/browser.js';
import type { StoreBacking } from './data/store/store.js';
import {
	createStoreOverPort,
	type DeclaredData,
	StoreError,
	StoreUnusableError,
} from './data/store/store.js';
import { defaultRuntime } from './platform/default.js';
import type { RecordingFactory, RecordingOwner } from './recorder.js';
import type {
	AppAiBinding,
	AppBlobFactory,
	AppSecretFactory,
} from './runtime.js';

/** Complete resources beneath the shared App lifecycle; no ambient fallback. */
export type AppRuntime = {
	/** Disposable runtimes reserve synchronously, before the returned promise settles. */
	claim: typeof claimApp;
	data(
		definition: ParsedDataDefinition,
		scope: AppDataScope,
	): Promise<Result<StoreBacking, StoreError>>;
	sqlite: DeviceSqliteOwner;
	blobs: AppBlobFactory;
	recording: RecordingFactory;
	secrets: AppSecretFactory;
	ai: AppAiBinding;
};

const log = createLogger('app');

/** Open one App lifetime with a complete runtime, defaulting to the current platform. */
export function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	{
		account,
		runtime = defaultRuntime(),
	}: { account?: Account; runtime?: AppRuntime } = {},
) {
	const appId = definition.id;
	const { sqlite, blobs, recording, secrets, ai, claim, data } = runtime;
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	const parsed = compileData(definition);
	if (parsed.error)
		throw new Error(parsed.error.message, { cause: parsed.error });
	const identity: AccountIdentity | null =
		account === undefined
			? null
			: Object.freeze({
					authorityId: account.authorityId,
					principalId: account.principalId,
				});
	const lifetime = new AbortController();
	let initialized = false;
	function assertUsable() {
		if (lifetime.signal.aborted) throw new StoreUnusableError();
		if (!initialized) throw new Error('The App is not ready.');
	}
	const databases = createAppSqlite(sqlite, appId, {
		assertUsable,
		account: identity ?? undefined,
	});
	let release: (() => void) | undefined;
	const scopes: Array<
		| { library: 'local'; account?: AccountIdentity }
		| { library: 'personal' | 'shared'; account: Account }
	> = [{ library: 'local', account: identity ?? undefined }];
	if (account) {
		scopes.push({ library: 'personal', account });
		if (account.supportsShared) scopes.push({ library: 'shared', account });
	}
	// Invoke admission now: a disposable runtime must reserve before we return.
	const ownership = (async (): Promise<Result<void, StoreError>> => {
		try {
			const acquired = await claim(appId, identity ?? undefined);
			if (acquired.error) return acquired;
			release = acquired.data.release;
			return Ok(undefined);
		} catch (cause) {
			return StoreError.StorageFailed({ cause });
		}
	})();
	const documents = scopes.map((scope) => {
		let released = true;
		const document = createStoreOverPort({
			definition: parsed.data,
			local: scope.library === 'local',
			assertUsable,
			async acquire() {
				const owned = await ownership;
				if (owned.error) return owned;
				if (lifetime.signal.aborted) return StoreError.ClosedWhileOpening();
				released = false;
				const opened = await data(parsed.data, {
					appId,
					...scope,
				});
				if (opened.error) {
					released = true;
					return opened;
				}
				return Ok({
					...opened.data,
					async dispose() {
						await opened.data.dispose?.();
						released = true;
					},
				});
			},
		});
		return {
			document,
			get released() {
				return released;
			},
			value: Object.assign(
				document.store,
				document.view as DeclaredData<TDefinition>,
				{
					appId,
					dataId: parsed.data.id,
					library: scope.library,
					signal: lifetime.signal,
				},
			),
		};
	});
	const device = documents[0]!;
	let blobAccess: ReturnType<typeof createAppBlobs> | undefined;
	let remoteBlobAccess: ReturnType<typeof createAppRemoteBlobs> | undefined;
	let secretAccess: ReturnType<AppRuntime['secrets']> | undefined;
	let recorder: RecordingOwner | undefined;
	let inference: ReturnType<typeof createAppAi> | undefined;
	let closing: Promise<void> | undefined;
	let canRetryClose = false;
	const libraryReplaced =
		account === undefined
			? undefined
			: Promise.race(
					documents.slice(1).map(({ document }) => document.libraryReplaced),
				);
	// Retained device methods retire with either account store, before UI teardown.
	for (const { document } of documents.slice(1)) {
		document.lifetime.signal.addEventListener('abort', () => lifetime.abort(), {
			once: true,
		});
	}
	lifetime.signal.addEventListener(
		'abort',
		() => {
			for (const { document } of documents) document.stopSync();
			void remoteBlobAccess
				?.close()
				.catch((cause) =>
					log.error(new Error('Remote blob cleanup failed.', { cause })),
				);
			void recorder
				?.close()
				.catch((cause) =>
					log.error(new Error('Recording cleanup failed.', { cause })),
				);
		},
		{ once: true },
	);
	function close(): Promise<void> {
		if (closing) return closing;
		const completion = Promise.withResolvers<void>();
		closing = completion.promise;
		canRetryClose = false;
		lifetime.abort();
		const closed = documents.map(({ document }) => document.close());
		void (async () => {
			const results = await Promise.allSettled([
				...closed,
				Promise.resolve().then(() => databases.drain()),
				Promise.resolve().then(() => blobAccess?.close()),
				Promise.resolve().then(() => remoteBlobAccess?.close()),
				Promise.resolve().then(() => secretAccess?.close()),
				Promise.resolve().then(() => inference?.close()),
				Promise.resolve().then(() => recorder?.close()),
			]);
			canRetryClose =
				results.some((result) => result.status === 'rejected') &&
				results.every(
					(result, index) =>
						result.status === 'fulfilled' ||
						(documents[index]?.document.canRetryClose ?? false),
				);
			const failures = results.filter((result) => result.status === 'rejected');
			if (
				documents.every((document) => document.released) &&
				results
					.slice(documents.length)
					.every((result) => result.status === 'fulfilled')
			) {
				try {
					await ownership;
					await databases.close();
					release?.();
					release = undefined;
				} catch (reason) {
					failures.push({ status: 'rejected', reason });
				}
			}
			if (failures.length === 1) throw failures[0]!.reason;
			if (failures.length > 1)
				throw new AggregateError(
					failures.map((failure) => failure.reason),
					'Application cleanup failed.',
				);
		})().then(completion.resolve, (cause) => {
			if (canRetryClose) closing = undefined;
			completion.reject(cause);
		});
		return closing;
	}
	const ready = Promise.all(
		documents.map(({ document }) => document.ready),
	).then(async (results) => {
		let result: Result<void, StoreError> =
			results.find((result) => result.error !== null) ?? Ok(undefined);
		if (!result.error) {
			try {
				await inference?.ready;
			} catch (cause) {
				result = StoreError.StorageFailed({ cause });
			}
		}
		if (!result.error && lifetime.signal.aborted)
			result = StoreError.ClosedWhileOpening();
		if (documents.some(({ document }) => document.isRetired))
			return StoreError.ClosedWhileOpening();
		if (result.error)
			await close().catch((cause) =>
				log.error(
					new Error('Application cleanup failed after opening failed.', {
						cause,
					}),
				),
			);
		else initialized = true;
		return result;
	});
	try {
		const bytes = blobs({ appId, account });
		blobAccess = createAppBlobs({ ...bytes, assertUsable });
		if (account && bytes.remote === null)
			throw new Error('An account App requires remote blob access.');
		if (bytes.remote !== null)
			remoteBlobAccess = createAppRemoteBlobs({
				remote: bytes.remote,
				assertUsable,
			});
		recorder = recording(appId, {
			assertUsable,
			account: identity ?? undefined,
			write: (id, blob) => bytes.local.put(id, blob),
		});
		const transport =
			account === undefined ? null : (ai.account?.(account) ?? null);
		inference = createAppAi({
			lifetime: { assertUsable, signal: lifetime.signal },
			account: transport && identity ? { ...transport, identity } : null,
			runtime: ai.runtime,
			connections: ai.connections?.(appId, identity ?? undefined) ?? null,
			configuredFetch: ai.configuredFetch,
		});
		secretAccess = secrets(appId, {
			assertUsable,
			account: identity ?? undefined,
		});
		const deviceScope = Object.freeze(
			Object.assign(device.value, {
				sqlite: databases.value,
				secrets: secretAccess.value,
				recording: recorder.value,
				connections: Object.freeze({
					runtime: inference.value.ai.runtime,
					custom: inference.value.ai.connections,
				}),
			}),
		);
		const accountScope =
			identity === null
				? undefined
				: Object.freeze({
						identity,
						personal: Object.freeze(documents[1]!.value),
						shared: documents[2] ? Object.freeze(documents[2].value) : null,
						connection: inference.value.ai.account,
					});
		return Object.freeze({
			appId,
			ready,
			close,
			signal: lifetime.signal,
			libraryReplaced,
			get canRetryClose() {
				return canRetryClose;
			},
			device: deviceScope,
			account: accountScope,
			blobs: Object.freeze({
				local: blobAccess.value,
				remote: remoteBlobAccess?.value ?? null,
			}),
		});
	} catch (cause) {
		void close().catch((error) =>
			log.error(
				new Error('Application construction cleanup failed.', { cause: error }),
			),
		);
		throw cause;
	}
}

export type App<TDefinition extends DataDefinition> = ReturnType<
	typeof openApp<TDefinition>
>;
