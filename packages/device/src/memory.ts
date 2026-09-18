import { deviceOwnerPath } from '@epicenter/principal';
import initialize, { type Database } from '@sqlite.org/sqlite-wasm';
import { createSqliteOwner, type DeviceSqliteOwner } from './owner.js';
import { sqliteOver } from './wasm-sqlite.js';

/** Runtime-owned memdb anchors retain bytes while App connections close physically. */
export function createMemorySqliteOwner() {
	const prefix = crypto.randomUUID();
	const anchors = new Map<string, Database>();
	let module: ReturnType<typeof initialize> | undefined;
	let leases = 0;
	let disposed = false;
	const backend = createSqliteOwner({
		async open(appId, name, account) {
			const sqlite = await (module ??= initialize());
			const filename = `/${prefix}/${JSON.stringify([appId, deviceOwnerPath(account), name])}`;
			if (!anchors.has(filename))
				anchors.set(filename, new sqlite.oo1.DB(filename, 'c', 'memdb'));
			const database = new sqlite.oo1.DB(filename, 'c', 'memdb');
			return {
				...sqliteOver(database, sqlite),
				async close() {
					database.close();
				},
			};
		},
		async delete(appId, name, account) {
			const filename = `/${prefix}/${JSON.stringify([appId, deviceOwnerPath(account), name])}`;
			anchors.get(filename)?.close();
			anchors.delete(filename);
		},
	});
	const owner: DeviceSqliteOwner = {
		async acquire(appId, account) {
			if (disposed) throw new Error('Memory SQLite runtime is disposed.');
			// Count before awaiting acquisition so disposal cannot pass a pending lease.
			leases++;
			try {
				const lifetime = await backend.acquire(appId, account);
				let closing: Promise<void> | undefined;
				return {
					...lifetime,
					close() {
						return (closing ??= lifetime.close().then(() => {
							leases--;
						}));
					},
				};
			} catch (cause) {
				leases--;
				throw cause;
			}
		},
	};
	return {
		owner,
		/** Dispose only after every SQL lifetime has successfully closed. */
		dispose() {
			if (leases) throw new Error('Memory SQLite lifetimes are still open.');
			disposed = true;
			for (const [name, anchor] of anchors) {
				anchor.close();
				anchors.delete(name);
			}
			module = undefined;
		},
	};
}
