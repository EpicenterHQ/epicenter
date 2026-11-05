/**
 * `@epicenter/folder/browser`: `openDevice(contract)`, a contract's typed
 * client over this origin's private file system (OPFS), at the same paths a
 * desktop folder holds: an app's local web variant, which keeps its files in
 * this browser for good and never uploads them (ADR-0700).
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import { createDeviceClient, storeOf } from './device/client.js';
import { DeviceError, opfsStore } from './device/opfs-store.js';
import { OpenFolderError } from './errors.js';

export { DeviceError } from './device/opfs-store.js';

/**
 * The typed client of `contract` over this origin's private file system, or
 * `StorageUnavailable` in a context with no Worker to own the files. The
 * Worker starts at the first call. A browser that gives the page no private
 * storage (WebKit's ephemeral contexts, Safari's private windows) still
 * opens: each call is then `Unavailable`, its cause a
 * `DeviceError.StorageRefused`, so an app can still render and explain why
 * nothing is kept (Whispering refuses to record there). A contract
 * that is not well formed throws.
 *
 * @example
 * ```ts
 * const device = await openDevice(recorder);
 * if (device.error !== null) return device;
 * const note = await device.data.recordings.create({ id: timeId(), title: 'Standup' });
 * ```
 *
 * `closeDevice(device)` stops its Worker (on hot reload, or at the end of a
 * test).
 */
export async function openDevice<TContract extends Contract>(
	contract: TContract,
): Promise<Result<Client<TContract>, OpenFolderError>> {
	if (typeof Worker === 'undefined')
		return OpenFolderError.StorageUnavailable({
			cause: DeviceError.WorkerFailed({ cause: 'this context has no Worker' })
				.error,
		});
	return Ok(createDeviceClient(contract, opfsStore()));
}

/**
 * Stop the Worker of a client `openDevice` returned; every later call is
 * `Unavailable`. Its files stay.
 */
export function closeDevice(device: Client<Contract>): void {
	storeOf(device).close?.();
}
