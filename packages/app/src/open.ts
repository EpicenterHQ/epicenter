import type { Account } from '@epicenter/auth';
import { createAppBlobs, createAppRemoteBlobs } from '@epicenter/blobs/app';
import { isAppId } from '@epicenter/constants/app-id';
import type { claimApp } from '@epicenter/device/library-claim';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { createAppSqlite } from '@epicenter/device/owner';
import type { AccountIdentity } from '@epicenter/principal';
import { createLogger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
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
import type { RecordingFactory } from './recorder.js';
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

/** Acquire and hydrate one App. A returned handle is ready; failures require page teardown. */
export async function openApp<const TDefinition extends DataDefinition>(
	definition: TDefinition,
	{
		account,
		runtime = defaultRuntime(),
	}: { account?: Account; runtime?: AppRuntime } = {},
) {
	const appId = definition.id;
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	const parsed = compileData(definition);
	if (parsed.error)
		throw new Error(parsed.error.message, { cause: parsed.error });
	const identity: AccountIdentity | undefined =
		account === undefined
			? undefined
			: Object.freeze({
					authorityId: account.authorityId,
					principalId: account.principalId,
				});
	// Memory admission reserves synchronously before this first await yields.
	const ownership = await runtime.claim(appId, identity);
	if (ownership.error) throw ownership.error;
	const claim = ownership.data;
	const lifetime = new AbortController();
	function assertUsable() {
		if (lifetime.signal.aborted) throw new StoreUnusableError();
	}
	// Every acquired resource registers its closer before the next acquisition.
	const cleanups: Array<() => void | Promise<void>> = [];
	// A returned error proves rollback; a thrown acquisition leaves release unproven.
	const acquisitionFailures: unknown[] = [];
	let closing: Promise<void> | undefined;
	function close(): Promise<void> {
		if (closing) return closing;
		const completion = Promise.withResolvers<void>();
		closing = completion.promise;
		lifetime.abort();
		void (async () => {
			const results = await Promise.allSettled(
				cleanups.map(async (cleanup) => cleanup()),
			);
			const failures = results.flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : [],
			);
			failures.push(...acquisitionFailures);
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1)
				throw new AggregateError(failures, 'Application cleanup failed.');
			claim.release();
		})().then(completion.resolve, completion.reject);
		return closing;
	}
	try {
		const databases = createAppSqlite(runtime.sqlite, appId, {
			assertUsable,
			account: identity,
		});
		cleanups.push(() => databases.close());
		const scopes: AppDataScope[] = [
			{ appId, library: 'local', account: identity },
		];
		if (account) {
			scopes.push({ appId, library: 'personal', account });
			if (account.supportsShared)
				scopes.push({ appId, library: 'shared', account });
		}
		const documents = scopes.map((scope) => {
			const document = createStoreOverPort({
				definition: parsed.data,
				local: scope.library === 'local',
				assertUsable,
				async acquire() {
					if (lifetime.signal.aborted) return StoreError.ClosedWhileOpening();
					try {
						return await runtime.data(parsed.data, scope);
					} catch (cause) {
						acquisitionFailures.push(cause);
						throw cause;
					}
				},
			});
			cleanups.push(() => document.close());
			document.lifetime.signal.addEventListener(
				'abort',
				() => {
					if (closing) return;
					void close().catch((cause) =>
						log.error(new Error('Application cleanup failed.', { cause })),
					);
				},
				{ once: true },
			);
			return {
				document,
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
		const bytes = runtime.blobs({ appId, account });
		const blobAccess = createAppBlobs({ ...bytes, assertUsable });
		cleanups.push(() => blobAccess.close());
		if (account && bytes.remote === null)
			throw new Error('An account App requires remote blob access.');
		const remoteBlobAccess =
			bytes.remote === null
				? null
				: createAppRemoteBlobs({ remote: bytes.remote, assertUsable });
		if (remoteBlobAccess) cleanups.push(() => remoteBlobAccess.close());
		const recorder = runtime.recording(appId, {
			assertUsable,
			account: identity,
			write: (id, blob) => bytes.local.put(id, blob),
		});
		cleanups.push(() => recorder.close());
		const secretAccess = runtime.secrets(appId, {
			assertUsable,
			account: identity,
		});
		cleanups.push(() => secretAccess.close());
		const transport =
			account === undefined ? null : (runtime.ai.account?.(account) ?? null);
		const connections = runtime.ai.connections?.(appId, identity) ?? null;
		// Register rollback before construction transfers the catalog to the AI owner.
		const catalogCleanup = cleanups.push(() => connections?.close()) - 1;
		const inference = createAppAi({
			lifetime: { assertUsable, signal: lifetime.signal },
			account: transport && identity ? { ...transport, identity } : null,
			runtime: runtime.ai.runtime,
			connections,
			configuredFetch: runtime.ai.configuredFetch,
		});
		cleanups[catalogCleanup] = () => inference.close();
		await Promise.all([
			...documents.map(async ({ document }) => {
				const result = await document.ready;
				if (result.error) throw result.error;
			}),
			inference.ready.catch((cause) => {
				throw StoreError.StorageFailed({ cause }).error;
			}),
		]);
		if (lifetime.signal.aborted) throw StoreError.ClosedWhileOpening().error;
		const device = Object.freeze(
			Object.assign(documents[0]!.value, {
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
			identity === undefined
				? undefined
				: Object.freeze({
						identity,
						personal: Object.freeze(documents[1]!.value),
						shared: documents[2] ? Object.freeze(documents[2].value) : null,
						connection: inference.value.ai.account,
					});
		return Object.freeze({
			appId,
			close,
			signal: lifetime.signal,
			device,
			account: accountScope,
			blobs: Object.freeze({
				local: blobAccess.value,
				remote: remoteBlobAccess?.value ?? null,
			}),
		});
	} catch (cause) {
		try {
			await close();
		} catch (cleanup) {
			throw new AggregateError(
				[cause, cleanup],
				'Application opening and cleanup failed.',
				{ cause },
			);
		}
		throw cause;
	}
}

export type App<TDefinition extends DataDefinition> = Awaited<
	ReturnType<typeof openApp<TDefinition>>
>;
