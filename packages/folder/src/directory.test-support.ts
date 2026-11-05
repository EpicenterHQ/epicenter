/**
 * The typed client over a directory, for this package's own tests of the
 * client and the folder: what `directory(path)` opens a folder to, held
 * without the folder.
 */
import { mkdir } from 'node:fs/promises';
import type { Client, Contract } from '@epicenter/definition/contract';
import { createDeviceClient } from './device/client.js';
import { nodeStore } from './device/node-store.js';

/** The client of `contract` over the directory at `path`, made when missing. */
export async function directoryClient<TContract extends Contract>(
	contract: TContract,
	path: string,
): Promise<Client<TContract>> {
	await mkdir(path, { recursive: true });
	return createDeviceClient(contract, nodeStore(path));
}
