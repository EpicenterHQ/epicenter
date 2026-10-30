/**
 * `@epicenter/folder/remote`: a contract's typed client over its repository
 * on Epicenter's server (decision 7), and the automatic upload of a
 * device's captures to it (decision 12).
 *
 * `openRemote(contract, { account })` reaches `<git>/~/<contract name>.git`,
 * the signed-in person's own repository for the app (decision 46). Every
 * request goes through `account.fetch`, so the remote stops working when the
 * account is retired; open a new one for a new account (decision 10).
 *
 * @example
 * ```ts
 * import { openDevice, outboxOf } from '@epicenter/folder/browser';
 * import { openRemote, startUploading } from '@epicenter/folder/remote';
 *
 * const device = openDevice(recorder);
 * const remote = openRemote(recorder, { account });
 * using uploader = startUploading(device, remote);
 *
 * const listed = await remote.recordings.list();
 * const note = await remote.recordings.get({ id });
 * if (note.error === null)
 *   await remote.recordings.update({ id }, { title: 'Standup' }, { over: note.data.version });
 * ```
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { createRemoteClient } from './remote/client.js';
import type { RemoteAccount } from './remote/wire.js';

export {
	startUploading,
	UPLOAD_LOCK,
	type Uploader,
	UploadRefusal,
	type UploadReport,
} from './remote/upload.js';
export { type RemoteAccount, RemoteError } from './remote/wire.js';

/**
 * The typed client of `contract` over the repository `account` (an
 * `@epicenter/auth` `Account`) reaches. A
 * version is the Git blob id on `main`. A server that cannot be reached is
 * `Unavailable` on each call, never a throw; a contract that is not well
 * formed throws here, at once.
 */
export function openRemote<TContract extends Contract>(
	contract: TContract,
	{ account }: { account: RemoteAccount },
): Client<TContract> {
	return createRemoteClient(contract, account);
}
