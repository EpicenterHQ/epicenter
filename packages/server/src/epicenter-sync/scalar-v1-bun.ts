import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
	type BlobByteSource,
	type BunBlobRead,
	createBunBlobFileStore,
} from '@epicenter/data/bun';
import {
	SCALAR_SYNC_V1_LIMITS,
	SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Server } from 'bun';
import type { Hono, MiddlewareHandler } from 'hono';
import { createLogger } from 'wellcrafted/logger';

import type { Env, ResolveDocumentPrincipal } from '../types.js';
import { type DataAuthorityV1, openScalarAuthorityV1 } from './authority-v1.js';
import { mountBackupV1App } from './backup-v1-route.js';
import {
	type AuthorityBlobV1,
	createAuthorityBlobV1,
} from './blob-authority-v1.js';
import type { BlobAuthorityV1Endpoint } from './blob-v1-route.js';
import { mountBlobV1App } from './blob-v1-route.js';
import {
	acquireBunAuthorityOwnerV1,
	openBunAuthorityControlV1,
} from './bun-authority-control-v1.js';
import {
	type BunBackupV1Owner,
	createBunBackupV1Owner,
} from './bun-backup-v1.js';
import {
	constructBunAuthorityFromPortable,
	recoverBunRestoreConstructionParent,
} from './bun-restore-v1.js';
import { createAuthorityCaptureManifestV1 } from './capture-manifest-v1.js';
import {
	type BunDataDocumentV1SocketData,
	type BunDocumentRealtimeV1Binding,
	createBunDocumentRealtimeV1Binding,
} from './document-realtime-v1-bun.js';
import {
	DOCUMENT_V1_REALTIME_PATH,
	resolveDocumentRealtimeV1Upgrade,
} from './document-realtime-v1-route.js';
import type { DocumentAuthorityV1Endpoint } from './document-v1-route.js';
import { mountDocumentV1App } from './document-v1-route.js';
import type { ScalarAuthorityV1Endpoint } from './scalar-v1-route.js';
import { mountScalarV1App } from './scalar-v1-route.js';

const AUTHORITY_LIFETIME =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type BunAuthorityBlobs = AuthorityBlobV1<BlobByteSource, BunBlobRead>;
type BunBackupEndpoint = Pick<BunBackupV1Owner, 'list' | 'delete'> & {
	create(): ReturnType<BunBackupV1Owner['create']>;
};
type BunDataEndpoint = ScalarAuthorityV1Endpoint & DocumentAuthorityV1Endpoint;

type OpenedAuthority = {
	authorityLifetime: string;
	directory: string;
	raw: Database;
	authority: DataAuthorityV1;
	captures: ReturnType<typeof createAuthorityCaptureManifestV1>;
	blobs: BunAuthorityBlobs;
	waitForBlobs(): Promise<void>;
};

type PrincipalState = {
	principalId: PrincipalId;
	authoritiesRoot: string;
	control: ReturnType<typeof openBunAuthorityControlV1>;
	owner: ReturnType<typeof acquireBunAuthorityOwnerV1>;
	backups: BunBackupV1Owner;
	current: OpenedAuthority;
	barrier: Promise<void> | undefined;
	unblock: (() => void) | undefined;
	operations: Set<Promise<unknown>>;
	resourceCancels: Set<() => Promise<void>>;
	retired: Set<Promise<void>>;
	backupRegistryTail: Promise<void>;
	restoring: Promise<unknown> | undefined;
	failure: unknown | undefined;
	dataEndpoint: BunDataEndpoint;
	blobEndpoint: BlobAuthorityV1Endpoint;
	backupEndpoint: BunBackupEndpoint;
};

export type BunRestoreResult = {
	authorityLifetime: string;
	recordCount: number;
};

export type BunRestoreBackupResult =
	| ({ kind: 'restored' } & BunRestoreResult)
	| { kind: 'backup-not-found' }
	| { kind: 'restore-in-progress' }
	| { kind: 'idempotency-conflict' };

function encodePathComponent(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw cause;
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Open the Bun host for one active Data authority per principal. */
export function createBunScalarV1Runtime({
	dir,
	restoreWorker,
}: {
	dir: string;
	restoreWorker?: () => Worker;
}) {
	mkdirSync(dir, { recursive: true });
	const log = createLogger('server/data-v1-bun');
	const loading = new Map<PrincipalId, Promise<PrincipalState>>();
	const opened = new Map<PrincipalId, PrincipalState>();
	let server: Server<BunDataDocumentV1SocketData> | undefined;
	let closed = false;
	let closing: Promise<void> | undefined;
	let documents: BunDocumentRealtimeV1Binding;

	function principalRoot(principalId: PrincipalId): string {
		return join(dir, 'principals', encodePathComponent(principalId));
	}

	function scheduleRetiredCleanup(
		state: PrincipalState,
		entry: OpenedAuthority,
	): void {
		const cleanup = (async () => {
			await entry.waitForBlobs();
			entry.raw.close();
			await rm(entry.directory, { recursive: true, force: true });
			await syncDirectory(state.authoritiesRoot);
		})();
		state.retired.add(cleanup);
		void cleanup.then(
			() => state.retired.delete(cleanup),
			(cause) =>
				log.error(new Error('Retired Bun authority cleanup failed', { cause })),
		);
	}

	async function openAuthority(
		principalId: PrincipalId,
		authoritiesRoot: string,
		authorityLifetime: string,
		initialize: boolean,
	): Promise<OpenedAuthority> {
		if (!AUTHORITY_LIFETIME.test(authorityLifetime)) {
			throw new Error('Bun authority pointer is not a lowercase UUID');
		}
		const directory = join(authoritiesRoot, authorityLifetime);
		const databasePath = join(directory, 'data-v1.sqlite');
		if (!initialize && !(await exists(databasePath))) {
			throw new Error('Selected Bun authority database is missing');
		}
		if (initialize) await mkdir(directory, { recursive: true });
		const raw = new Database(databasePath, {
			create: initialize,
			strict: true,
		});
		try {
			raw.run('PRAGMA journal_mode = WAL');
			raw.run('PRAGMA synchronous = FULL');
			const database = createBunSqliteAdapter(raw);
			const stored = openScalarAuthorityV1({
				database,
				limits: SCALAR_SYNC_V1_LIMITS,
				...(initialize ? { initialize: { authorityLifetime } } : {}),
			});
			if (stored.authorityLifetime() !== authorityLifetime) {
				throw new Error(
					'Selected Bun authority lifetime does not match its path',
				);
			}
			const captures = createAuthorityCaptureManifestV1(database);
			const blobs = createAuthorityBlobV1(
				database,
				createBunBlobFileStore(directory),
			);
			let blobMaintenance = blobs.reopenSweep();
			await blobMaintenance;
			function scheduleBlobSweep(): void {
				blobMaintenance = blobMaintenance.then(
					() => blobs.sweepDebris(),
					() => blobs.sweepDebris(),
				);
				void blobMaintenance.catch(() => undefined);
			}
			const authority: DataAuthorityV1 = {
				...stored,
				submit(request) {
					const result = stored.submit(request);
					if (result.error === null) {
						for (const fact of result.data.facts) {
							if (fact.state === 'tombstone') {
								documents.closeAddress(principalId, fact.address);
								scheduleBlobSweep();
							}
						}
					}
					return result;
				},
			};
			return {
				authorityLifetime,
				directory,
				raw,
				authority,
				captures,
				blobs,
				waitForBlobs: () => blobMaintenance,
			};
		} catch (cause) {
			raw.close();
			throw cause;
		}
	}

	function runLease<TResult>(
		state: PrincipalState,
		operation: (entry: OpenedAuthority) => TResult | Promise<TResult>,
	): Promise<TResult> {
		if (closed)
			return Promise.reject(new Error('Bun scalar V1 runtime is closed'));
		if (state.failure !== undefined) return Promise.reject(state.failure);
		if (state.barrier !== undefined) {
			return state.barrier.then(() => runLease(state, operation));
		}
		const entry = state.current;
		const result = Promise.resolve().then(() => operation(entry));
		state.operations.add(result);
		void result
			.finally(() => state.operations.delete(result))
			.catch(() => undefined);
		return result;
	}

	async function runBackupRegistryOperation<TResult>(
		state: PrincipalState,
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		const preceding = state.backupRegistryTail;
		let release!: () => void;
		const turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		state.backupRegistryTail = preceding.then(() => turn);
		await preceding;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	function leasedBlobRead(
		state: PrincipalState,
		address: Parameters<BlobAuthorityV1Endpoint['read']>[0],
	): Promise<ReadableStream<Uint8Array> | undefined> {
		return runLease(state, async (entry) => {
			const source = await entry.blobs.read(address);
			if (source === undefined) return undefined;
			const reader = source.getReader();
			let completed = false;
			let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
			let releaseHold: () => void = () => undefined;
			const hold = new Promise<void>((resolveHold) => {
				releaseHold = resolveHold;
			});
			state.operations.add(hold);
			async function finish(cancel: boolean): Promise<void> {
				if (completed) return;
				completed = true;
				state.resourceCancels.delete(cancelResource);
				try {
					if (cancel) await reader.cancel('authority-replaced');
				} finally {
					reader.releaseLock();
					state.operations.delete(hold);
					releaseHold();
				}
			}
			async function cancelResource(): Promise<void> {
				if (completed) return;
				const cause = new Error(
					'Blob read interrupted by authority replacement',
				);
				controller?.error(cause);
				await finish(true);
			}
			state.resourceCancels.add(cancelResource);
			return new ReadableStream<Uint8Array>({
				start(outward) {
					controller = outward;
				},
				async pull(outward) {
					if (completed) {
						outward.close();
						return;
					}
					try {
						const result = await reader.read();
						if (result.done) {
							await finish(false);
							outward.close();
						} else {
							outward.enqueue(result.value);
						}
					} catch (cause) {
						const interrupted = completed;
						await finish(false);
						if (!interrupted) outward.error(cause);
					}
				},
				cancel: () => finish(true),
			});
		});
	}

	function createGateways(state: PrincipalState): void {
		state.dataEndpoint = {
			readFacts: (request) =>
				runLease(state, (entry) => entry.authority.readFacts(request)),
			submit: (request) =>
				runLease(state, async (entry) => {
					const result = entry.authority.submit(request);
					await entry.waitForBlobs();
					return result;
				}),
			acceptDocument: (request) =>
				runLease(state, (entry) => entry.authority.acceptDocument(request)),
		};
		state.blobEndpoint = {
			accept: (request, bytes) =>
				runLease(state, (entry) => entry.blobs.accept(request, bytes)),
			read: (address) => leasedBlobRead(state, address),
		};
		state.backupEndpoint = {
			create: () =>
				runBackupRegistryOperation(state, () =>
					runLease(state, (entry) =>
						state.backups.create({
							captures: entry.captures,
							blobs: entry.blobs,
						}),
					),
				),
			list: () => runBackupRegistryOperation(state, () => state.backups.list()),
			delete: (backupId) =>
				runBackupRegistryOperation(state, () => {
					if (state.control.activeRestoreRequest()?.backupId === backupId) {
						throw new Error('Bun Backup Restore is incomplete');
					}
					return state.backups.delete(backupId);
				}),
		};
	}

	async function loadPrincipal(
		principalId: PrincipalId,
	): Promise<PrincipalState> {
		if (closed) throw new Error('Bun scalar V1 runtime is closed');
		const existing = loading.get(principalId);
		if (existing !== undefined) return existing;
		const load = (async () => {
			const root = principalRoot(principalId);
			const authoritiesRoot = join(root, 'authorities');
			await mkdir(root, { recursive: true });
			const owner = acquireBunAuthorityOwnerV1(root);
			let control: ReturnType<typeof openBunAuthorityControlV1>;
			try {
				await mkdir(authoritiesRoot, { recursive: true });
				control = openBunAuthorityControlV1(root);
			} catch (cause) {
				owner.close();
				throw cause;
			}
			let current: OpenedAuthority | undefined;
			let backups: BunBackupV1Owner | undefined;
			try {
				await recoverBunRestoreConstructionParent(authoritiesRoot);
				let active = control.active();
				if (active === undefined) {
					const entries = await readdir(authoritiesRoot, {
						withFileTypes: true,
					});
					if (entries.length > 1) {
						throw new Error(
							'Bun authority control pointer is ambiguous for existing authority data',
						);
					}
					const recovered = entries[0];
					if (recovered === undefined) {
						active = crypto.randomUUID();
						current = await openAuthority(
							principalId,
							authoritiesRoot,
							active,
							true,
						);
					} else {
						if (
							!recovered.isDirectory() ||
							!AUTHORITY_LIFETIME.test(recovered.name)
						) {
							throw new Error(
								'Bun authority control pointer is missing for unrecognized authority data',
							);
						}
						active = recovered.name;
						current = await openAuthority(
							principalId,
							authoritiesRoot,
							active,
							false,
						);
					}
					await syncDirectory(current.directory);
					await syncDirectory(authoritiesRoot);
					control.initialize(active);
					await syncDirectory(root);
				} else {
					current = await openAuthority(
						principalId,
						authoritiesRoot,
						active,
						false,
					);
				}
				const interruptedRestore = control.activeRestoreRequest();
				if (
					interruptedRestore !== undefined &&
					interruptedRestore.successorLifetime === active
				) {
					control.completeRestore(interruptedRestore.requestId);
				}
				for (const entry of await readdir(authoritiesRoot, {
					withFileTypes: true,
				})) {
					if (!entry.isDirectory() || entry.name === active) continue;
					if (!AUTHORITY_LIFETIME.test(entry.name)) {
						throw new Error('Bun authority directory is not recognized');
					}
					await rm(join(authoritiesRoot, entry.name), {
						recursive: true,
						force: true,
					});
				}
				await syncDirectory(authoritiesRoot);
				backups = createBunBackupV1Owner({
					backupsRoot: join(root, 'backups'),
				});
				const state = {
					principalId,
					authoritiesRoot,
					control,
					owner,
					backups,
					current,
					barrier: undefined,
					unblock: undefined,
					operations: new Set(),
					resourceCancels: new Set(),
					retired: new Set(),
					backupRegistryTail: Promise.resolve(),
					restoring: undefined,
					failure: undefined,
					dataEndpoint: undefined as unknown as BunDataEndpoint,
					blobEndpoint: undefined as unknown as BlobAuthorityV1Endpoint,
					backupEndpoint: undefined as unknown as BunBackupEndpoint,
				} satisfies PrincipalState;
				createGateways(state);
				opened.set(principalId, state);
				return state;
			} catch (cause) {
				await backups?.close().catch(() => undefined);
				if (current !== undefined) {
					await current.waitForBlobs().catch(() => undefined);
					current.raw.close();
				}
				control.close();
				owner.close();
				throw cause;
			}
		})();
		loading.set(principalId, load);
		return load;
	}

	async function cancelResourcesAndDrain(state: PrincipalState): Promise<void> {
		while (state.operations.size > 0) {
			await Promise.allSettled(
				[...state.resourceCancels].map((cancel) => cancel()),
			);
			await Promise.allSettled([...state.operations]);
		}
	}

	function beginBarrier(state: PrincipalState): void {
		if (state.barrier !== undefined) {
			throw new Error('Bun authority is already quiescing');
		}
		state.barrier = new Promise<void>((resolveBarrier) => {
			state.unblock = resolveBarrier;
		});
		documents.pausePrincipal(state.principalId);
	}

	function endBarrier(state: PrincipalState): void {
		documents.resumePrincipal(state.principalId);
		releaseBarrier(state);
	}

	function failBarrier(state: PrincipalState, cause: unknown): void {
		state.failure = cause;
		releaseBarrier(state);
	}

	function releaseBarrier(state: PrincipalState): void {
		const unblock = state.unblock;
		state.unblock = undefined;
		state.barrier = undefined;
		unblock?.();
	}

	async function performRestore(
		state: PrincipalState,
		portableDirectory: string,
		successorLifetime: string = crypto.randomUUID(),
	): Promise<BunRestoreResult> {
		if (state.failure !== undefined) throw state.failure;
		const outgoing = state.current;
		const successorDirectory = join(state.authoritiesRoot, successorLifetime);
		const construction = await constructBunAuthorityFromPortable(
			{
				portableDirectory,
				targetDirectory: successorDirectory,
				authorityLifetime: successorLifetime,
			},
			{
				...(restoreWorker === undefined ? {} : { createWorker: restoreWorker }),
			},
		);
		let successor: OpenedAuthority | undefined;
		let committed = false;
		let failClosed = false;
		try {
			beginBarrier(state);
			await cancelResourcesAndDrain(state);
			await outgoing.waitForBlobs();
			if (state.current !== outgoing) {
				throw new Error('Bun authority changed before activation');
			}
			successor = await openAuthority(
				state.principalId,
				state.authoritiesRoot,
				successorLifetime,
				false,
			);
			const activation = state.control.activate(
				outgoing.authorityLifetime,
				successorLifetime,
			);
			if (activation.kind === 'unchanged') throw activation.cause;
			if (activation.kind === 'indeterminate') {
				const preservationFailures: unknown[] = [];
				try {
					successor.raw.close();
				} catch (failure) {
					preservationFailures.push(failure);
				}
				successor = undefined;
				failClosed = true;
				throw new AggregateError(
					[activation.cause, ...preservationFailures],
					`Bun authority activation is indeterminate${
						activation.selected === undefined
							? ''
							: `: selected ${activation.selected}`
					}`,
				);
			}
			state.current = successor;
			committed = true;
			successor = undefined;
			endBarrier(state);
			scheduleRetiredCleanup(state, outgoing);
			return construction;
		} catch (cause) {
			if (!committed && !failClosed) {
				const cleanupFailures: unknown[] = [];
				try {
					if (successor !== undefined) {
						try {
							successor.raw.close();
						} catch (failure) {
							cleanupFailures.push(failure);
						}
					}
					await rm(successorDirectory, { recursive: true, force: true }).catch(
						(failure) => cleanupFailures.push(failure),
					);
				} finally {
					if (state.barrier !== undefined) endBarrier(state);
				}
				if (cleanupFailures.length > 0) {
					throw new AggregateError(
						[cause, ...cleanupFailures],
						'Bun authority Restore failed and cleanup was incomplete',
					);
				}
			} else {
				failBarrier(state, cause);
			}
			throw cause;
		}
	}

	documents = createBunDocumentRealtimeV1Binding({
		locateAuthority(principalId) {
			const state = opened.get(principalId);
			if (state === undefined) {
				throw new Error('Bun document authority is not loaded');
			}
			return state.current.authority;
		},
	});

	return {
		async locateAuthority(principalId: PrincipalId) {
			return (await loadPrincipal(principalId)).dataEndpoint;
		},
		async locateBlobAuthority(principalId: PrincipalId) {
			return (await loadPrincipal(principalId)).blobEndpoint;
		},
		async locateBackupOwner(principalId: PrincipalId) {
			return (await loadPrincipal(principalId)).backupEndpoint;
		},
		async restorePortable(
			principalId: PrincipalId,
			portableDirectory: string,
		): Promise<BunRestoreResult> {
			const state = await loadPrincipal(principalId);
			if (state.restoring !== undefined) {
				throw new Error('Bun authority Restore is already active');
			}
			if (state.control.activeRestoreRequest() !== undefined) {
				throw new Error('Bun Backup Restore is incomplete');
			}
			const restoring = runBackupRegistryOperation(state, () =>
				performRestore(state, portableDirectory),
			);
			state.restoring = restoring;
			try {
				return await restoring;
			} finally {
				state.restoring = undefined;
			}
		},
		async restoreBackup(
			principalId: PrincipalId,
			backupId: string,
			restoreRequestId: string,
		): Promise<BunRestoreBackupResult> {
			const state = await loadPrincipal(principalId);
			if (state.restoring !== undefined) {
				return { kind: 'restore-in-progress' };
			}
			const restoring = runBackupRegistryOperation(state, async () => {
				let request = state.control.restoreRequest(restoreRequestId);
				if (request !== undefined) {
					if (request.backupId !== backupId) {
						return { kind: 'idempotency-conflict' as const };
					}
					if (request.state === 'succeeded') {
						return {
							kind: 'restored' as const,
							authorityLifetime: request.successorLifetime,
							recordCount: request.recordCount,
						};
					}
					if (state.control.active() === request.successorLifetime) {
						request = state.control.completeRestore(request.requestId);
						return {
							kind: 'restored' as const,
							authorityLifetime: request.successorLifetime,
							recordCount: request.recordCount,
						};
					}
				} else if (state.control.activeRestoreRequest() !== undefined) {
					return { kind: 'restore-in-progress' as const };
				}

				const backup = await state.backups.get(backupId);
				if (backup === undefined) {
					if (request !== undefined) {
						state.control.abandonRestore(request.requestId);
					}
					return { kind: 'backup-not-found' as const };
				}
				request ??= state.control.beginRestore(
					restoreRequestId,
					backupId,
					crypto.randomUUID(),
					backup.recordCount,
				);
				try {
					const restored = await performRestore(
						state,
						backup.directory,
						request.successorLifetime,
					);
					if (restored.recordCount !== request.recordCount) {
						throw new Error(
							'Bun Restore record count changed during construction',
						);
					}
					request = state.control.completeRestore(request.requestId);
					return {
						kind: 'restored' as const,
						authorityLifetime: request.successorLifetime,
						recordCount: request.recordCount,
					};
				} catch (cause) {
					try {
						if (state.control.active() === request.successorLifetime) {
							request = state.control.completeRestore(request.requestId);
							return {
								kind: 'restored' as const,
								authorityLifetime: request.successorLifetime,
								recordCount: request.recordCount,
							};
						}
						state.control.abandonRestore(request.requestId);
					} catch (reconciliationCause) {
						throw new AggregateError(
							[cause, reconciliationCause],
							'Bun Restore outcome is indeterminate',
						);
					}
					throw cause;
				}
			});
			state.restoring = restoring;
			try {
				return await restoring;
			} finally {
				state.restoring = undefined;
			}
		},
		websocket: documents.websocket,
		bindServer(bound: Server<BunDataDocumentV1SocketData>): void {
			server = bound;
		},
		async acceptDocumentUpgrade(
			request: Request,
			verified: {
				principalId: PrincipalId;
				address: Parameters<typeof documents.closeAddress>[1];
				authorityLifetime: string;
				authorizationExpiresAt: number;
			},
		): Promise<Response> {
			const state = await loadPrincipal(verified.principalId);
			if (state.failure !== undefined) {
				return new Response('Data authority is unavailable', { status: 503 });
			}
			if (server === undefined) {
				return new Response('Data document server not bound', { status: 500 });
			}
			return documents.handleAuthorizedUpgrade(request, server, verified);
		},
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closed = true;
			closing = (async () => {
				const failures: unknown[] = [];
				try {
					documents.closeAll();
				} catch (cause) {
					failures.push(cause);
				}
				const loaded = await Promise.allSettled([...loading.values()]);
				const states = loaded.flatMap((result) =>
					result.status === 'fulfilled' ? [result.value] : [],
				);
				failures.push(
					...loaded.flatMap((result) =>
						result.status === 'rejected' ? [result.reason] : [],
					),
				);
				for (const state of states) {
					if (state.restoring !== undefined) {
						const result = await Promise.allSettled([state.restoring]);
						if (result[0]?.status === 'rejected') {
							failures.push(result[0].reason);
						}
					}
					await cancelResourcesAndDrain(state).catch((cause) =>
						failures.push(cause),
					);
					const retired = await Promise.allSettled([...state.retired]);
					for (const result of retired) {
						if (result.status === 'rejected') failures.push(result.reason);
					}
					const owner = await Promise.allSettled([
						state.backups.close(),
						state.current.waitForBlobs(),
					]);
					for (const result of owner) {
						if (result.status === 'rejected') failures.push(result.reason);
					}
					state.current.raw.close();
					state.control.close();
					state.owner.close();
				}
				opened.clear();
				if (failures.length > 0) {
					throw new AggregateError(
						failures,
						'Bun scalar V1 runtime close failed',
					);
				}
			})();
			return closing;
		},
	};
}

export type BunScalarV1Runtime = ReturnType<typeof createBunScalarV1Runtime>;

/** Mount the authenticated Data V1 surfaces on a Bun deployment. */
export function mountBunScalarV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveDocumentPrincipal,
		runtime,
	}: {
		auth: MiddlewareHandler<E>;
		resolveDocumentPrincipal: ResolveDocumentPrincipal<E>;
		runtime: BunScalarV1Runtime;
	},
): void {
	mountScalarV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		rawSubmissionBytes: SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
		locateAuthority: runtime.locateAuthority,
	});
	mountDocumentV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		locateAuthority: runtime.locateAuthority,
	});
	mountBlobV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		locateAuthority: runtime.locateBlobAuthority,
	});
	mountBackupV1App(app, {
		auth,
		locateRegistry: runtime.locateBackupOwner,
		restoreBackup: (principalId, backupId, restoreRequestId) =>
			runtime.restoreBackup(principalId, backupId, restoreRequestId),
	});
	app.get(DOCUMENT_V1_REALTIME_PATH, async (c) => {
		const verified = await resolveDocumentRealtimeV1Upgrade(
			c,
			resolveDocumentPrincipal,
		);
		if (verified === undefined) {
			return new Response('WebSocket upgrade refused', { status: 401 });
		}
		return runtime.acceptDocumentUpgrade(c.req.raw, verified);
	});
}
