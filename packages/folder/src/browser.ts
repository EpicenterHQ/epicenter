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
import type { DeviceStore } from './device/store.js';
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

/** A device's files by path: what `deviceFiles` answers. */
export type DeviceFiles = Pick<DeviceStore, 'list' | 'read' | 'write'> &
	Required<Pick<DeviceStore, 'append'>>;

/**
 * The files under a client `openDevice` returned, by path, for code that
 * writes a file while it is made: a recording appended as it records
 * (`append`), and repaired after a closed tab cut it off (`read`, then
 * `write` over the version read). Every change lands as the client's own
 * do, and its listeners hear it the same way. Nothing here checks a path
 * against the contract: a caller writes only paths its contract gives a
 * file collection, such as `recordings/{id}.{ext}`.
 */
export function deviceFiles(device: Client<Contract>): DeviceFiles {
	const { list, read, write, append } = storeOf(device);
	if (append === undefined)
		throw new Error('expected a client openDevice from /browser returned');
	return { list, read, write, append };
}

/**
 * Where a folder over this browser's files keeps its open attempt. A symbol
 * member, so the copy `reactive` makes of the folder carries it too.
 */
const OPENING = Symbol('epicenter.browserFiles');

type Opening = () =>
	| Promise<Result<Client<Contract>, OpenFolderError>>
	| undefined;

/** Mark `folder` as one over this browser's files, whose open attempt `opening` answers. */
export function holdOpening(folder: object, opening: Opening): void {
	Object.defineProperty(folder, OPENING, { value: opening });
}

/**
 * The files under `folder` by path (`deviceFiles`), once it opened: the
 * folder `openFolder` returned over this browser's files, or `reactive`'s
 * copy of it. Null for any other folder, and for one whose open failed.
 */
export async function filesOf(folder: object): Promise<DeviceFiles | null> {
	const opening = (folder as { [OPENING]?: Opening })[OPENING]?.();
	if (opening === undefined) return null;
	const opened = await opening;
	return opened.error === null ? deviceFiles(opened.data) : null;
}
