import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { createRemoteBlobClient } from '@epicenter/client';
import { LibraryClaimError } from '@epicenter/device/library-claim';
import { createMemorySqliteOwner } from '@epicenter/device/memory';
import { deviceOwnerPath } from '@epicenter/principal';
import * as indexedDb from 'fake-indexeddb';
import { Ok } from 'wellcrafted/result';
import { accountInference } from './ai.js';
import { createAiConnections } from './ai-connections.js';
import { acquireAppData } from './data/store/browser.js';
import { RecorderError } from './recorder.js';
import type { AppRuntime } from './runtime.js';

/**
 * Isolated storage for Bun or compatible nonbrowser test processes.
 * Requires fake IndexedDB constructors; incompatible native constructors are
 * rejected before globals change. Browser integration tests use the default runtime.
 * Apps close their handles; disposal erases this runtime's storage.
 */
export function createMemoryRuntime() {
	// idb wraps requests using instanceof. Supply absent constructors, never replace
	// the ambient storage factory or swap globals when individual Apps open.
	const constructors = [
		'IDBCursor',
		'IDBCursorWithValue',
		'IDBDatabase',
		'IDBIndex',
		'IDBKeyRange',
		'IDBObjectStore',
		'IDBRequest',
		'IDBTransaction',
	] as const;
	for (const name of constructors) {
		if (globalThis[name] !== undefined && globalThis[name] !== indexedDb[name])
			throw new Error(
				'Memory runtime requires an isolated test process without native IndexedDB constructors.',
			);
	}
	for (const name of constructors) {
		if (globalThis[name] === undefined)
			Object.defineProperty(globalThis, name, {
				configurable: true,
				writable: true,
				value: indexedDb[name],
			});
	}
	const factory = new indexedDb.IDBFactory();
	const sql = createMemorySqliteOwner();
	const held = new Set<string>();
	const secrets = new Map<string, Map<string, string>>();
	const catalog = new Map<string, string>();
	const changes = new Map<string, Set<() => void>>();
	let disposed = false;
	let disposing: Promise<void> | undefined;
	const runtime: AppRuntime = {
		async claim(appId, account) {
			const address = JSON.stringify([appId, deviceOwnerPath(account)]);
			if (disposed)
				return LibraryClaimError.ClaimFailed({
					address,
					cause: new Error('Memory runtime is disposed.'),
				});
			if (held.has(address)) return LibraryClaimError.AlreadyOpen({ address });
			held.add(address);
			let released = false;
			return Ok({
				release() {
					if (released) return;
					released = true;
					held.delete(address);
				},
			});
		},
		data(definition, scope) {
			return acquireAppData(definition, { ...scope, indexedDB: factory });
		},
		sqlite: sql.owner,
		blobs({ appId, account }) {
			const local = createBrowserBlobStore({
				appId,
				account,
				indexedDb: factory,
			});
			return {
				local,
				sources: createBrowserBlobSources(local),
				remote:
					account === undefined
						? null
						: createRemoteBlobClient({ appId, account, local }),
			};
		},
		secrets(appId, { account, assertUsable } = {}) {
			const key = JSON.stringify([appId, deviceOwnerPath(account)]);
			let closed = false;
			function values() {
				assertUsable?.();
				if (closed || disposed) throw new Error('Secret store is closed.');
				let result = secrets.get(key);
				if (!result) {
					result = new Map();
					secrets.set(key, result);
				}
				return result;
			}
			return {
				value: {
					async get(label) {
						return Ok(values().get(label) ?? null);
					},
					async put(label, value) {
						values().set(label, value);
						return Ok(undefined);
					},
					async delete(label) {
						values().delete(label);
						return Ok(undefined);
					},
				},
				async close() {
					closed = true;
				},
			};
		},
		recording(_appId, { assertUsable }) {
			let closed = false;
			function assertOpen() {
				assertUsable?.();
				if (closed) throw new Error('Recording is closed.');
			}
			return {
				value: {
					async current() {
						assertOpen();
						return Ok(null);
					},
					async enumerateDevices() {
						assertOpen();
						return Ok([]);
					},
					async start() {
						assertOpen();
						return RecorderError.NoInputDevice();
					},
				},
				async close() {
					closed = true;
				},
			};
		},
		ai: {
			runtime: null,
			account: accountInference,
			async configuredFetch() {
				throw new Error(
					'Memory runtime has no configured inference transport.',
				);
			},
			connections(_appId, account) {
				const key = deviceOwnerPath(account);
				let listeners = changes.get(key);
				if (!listeners) {
					listeners = new Set();
					changes.set(key, listeners);
				}
				const subscribers = listeners;
				return createAiConnections({
					storageKey: key,
					storage: {
						getItem(key) {
							return catalog.get(key) ?? null;
						},
						setItem(key, value) {
							catalog.set(key, value);
						},
					},
					publishStorage() {
						for (const listener of subscribers) listener();
					},
					subscribeStorage(listener) {
						subscribers.add(listener);
						return () => subscribers.delete(listener);
					},
				});
			},
		},
	};
	return {
		...runtime,
		/** Refuses active, pending, and failed-cleanup Apps; never closes Apps for callers. */
		async dispose() {
			if (held.size) throw new Error('Memory runtime still has open Apps.');
			if (disposing) return disposing;
			disposed = true;
			disposing = (async () => {
				sql.dispose();
				for (const { name } of await factory.databases()) {
					if (name === undefined) continue;
					await new Promise<void>((resolve, reject) => {
						const request = factory.deleteDatabase(name);
						request.onsuccess = () => resolve();
						request.onerror = () => reject(request.error);
						request.onblocked = () =>
							reject(new Error('Memory storage is still open.'));
					});
				}
				secrets.clear();
				catalog.clear();
				changes.clear();
			})();
			return disposing;
		},
	};
}
