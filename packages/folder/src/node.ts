/**
 * `@epicenter/folder/node`: a contract's typed client over a directory on
 * this computer (decision 7), and the checks `epicenter check` and
 * `epicenter format` run. It runs in Bun: a write takes the directory's save
 * lock, which the desktop shell shares, through `bun:sqlite`.
 *
 * The directory holds the contract's files at the contract's paths, the
 * same layout a desktop folder and the browser's private storage hold.
 *
 * @example
 * ```ts
 * import { openDevice } from '@epicenter/folder/node';
 *
 * const device = openDevice(recorder, { path: '/Users/me/Recordings' });
 * const note = await device.recordings.create({ id: timeId(), title: 'Standup' });
 * ```
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { createDeviceClient } from './device/client.js';
import { checkStore, formatStore } from './device/folder-tools.js';
import { nodeStore } from './device/node-store.js';

export { type AppConfig, appConfig } from './app-config.js';

/**
 * The typed client of `contract` over the directory at `path`, made at the
 * first call if it does not exist. A directory that cannot be reached is
 * `Unavailable` on each call, never a throw; a contract that is not well
 * formed throws here, at once.
 */
export function openDevice<TContract extends Contract>(
	contract: TContract,
	{ path }: { path: string },
): Client<TContract> {
	return createDeviceClient(contract, nodeStore(path, { create: true }));
}

/**
 * Every file of the existing directory at `path` checked against `contract`, a
 * contract as code or parsed JSON: `{ files, issues }`, with one issue per
 * problem in path order. A contract that is not well formed is the error.
 */
export function checkFiles(contract: unknown, { path }: { path: string }) {
	return checkStore(contract, nodeStore(path, { create: false }));
}

/**
 * Rewrite every note `contract` claims in the directory at `path` in house
 * style: `{ formatted, unchanged, refused }`.
 */
export function formatNotes(contract: unknown, { path }: { path: string }) {
	return formatStore(contract, nodeStore(path, { create: false }));
}
