import { DeviceError } from '@epicenter/device';
import type { SqliteLifetime } from '@epicenter/device/owner';
import { isDatabaseName } from '@epicenter/device/protocol';
import { type Result, tryAsync } from 'wellcrafted/result';

/** Borrowed SQL access; the containing store owns admission and physical close. */
export function borrowSqlite(
	namespace: SqliteLifetime,
	assertUsable: () => void,
) {
	return Object.freeze({
		async open(
			name: string,
		): Promise<
			Result<Awaited<ReturnType<typeof namespace.open>>, DeviceError>
		> {
			assertUsable();
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
			assertUsable();
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
	});
}
