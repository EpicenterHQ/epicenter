import { createBrowserSqliteOwner } from '@epicenter/device/browser';
import { createDesktopSqliteOwner } from '@epicenter/device/desktop';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { isDatabaseName } from '@epicenter/device/protocol';
import { DeviceError } from '@epicenter/device';
import { isTauri } from '@tauri-apps/api/core';
import type { Result } from 'wellcrafted/result';
import { tryAsync } from 'wellcrafted/result';

const browser = createBrowserSqliteOwner();
const desktop = createDesktopSqliteOwner();

/** Acquire the namespace now; individual databases remain dynamically named. */
export async function openSqlite({
	id,
	owner = isTauri() ? desktop : browser,
}: {
	id: string;
	owner?: DeviceSqliteOwner;
}) {
	const namespace = await owner.acquire(id);
	const lifetime = new AbortController();
	let closing: Promise<void> | undefined;
	return Object.freeze({
		signal: lifetime.signal,
		async open(
			name: string,
		): Promise<
			Result<Awaited<ReturnType<typeof namespace.open>>, DeviceError>
		> {
			lifetime.signal.throwIfAborted();
			if (!isDatabaseName(name))
				return Promise.resolve(
					DeviceError.InvalidDatabaseName({ databaseName: name }),
				);
			return tryAsync({
				try: () => namespace.open(name),
				catch: (cause) => DeviceError.StorageFailed({ cause }),
			});
		},
		async delete(name: string): Promise<Result<void, DeviceError>> {
			lifetime.signal.throwIfAborted();
			if (!isDatabaseName(name))
				return Promise.resolve(
					DeviceError.InvalidDatabaseName({ databaseName: name }),
				);
			return tryAsync({
				try: async () => {
					await namespace.delete(name);
					return undefined;
				},
				catch: (cause) => DeviceError.StorageFailed({ cause }),
			});
		},
		close(): Promise<void> {
			if (closing) return closing;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			// Fence the namespace before abort listeners can use retained connections.
			const cleanup = namespace.close();
			lifetime.abort();
			cleanup.then(completion.resolve, completion.reject);
			return closing;
		},
	});
}
export type Sqlite = Awaited<ReturnType<typeof openSqlite>>;
