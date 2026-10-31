/**
 * `@epicenter/folder/remote`: a contract's typed client over its repository
 * on Epicenter's server (decision 7), what an app's online web variant
 * reads and writes. It keeps nothing on the device: every call is a request,
 * and every write a commit (ADR-0700).
 *
 * `openRemote(contract, { account })` reaches `<git>/~/<contract name>.git`,
 * the signed-in person's own repository for the app (decision 46);
 * `{ repository: '<owner>/<name>' }` reaches another person's, which they
 * shared with this account (a `read` grant reads, a `write` grant also
 * writes). Every request goes through `account.fetch`, so the remote stops
 * working when the account is retired; open a new one for a new account
 * (decision 10).
 *
 * @example
 * ```ts
 * import { openRemote } from '@epicenter/folder/remote';
 *
 * const remote = openRemote(recorder, { account });
 * const shared = openRemote(recorder, { account, repository: 'k3x9m2p7q1zt/recorder' });
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

export { type RemoteAccount, RemoteError } from './remote/wire.js';

/**
 * The typed client of `contract` over a repository `account` (an
 * `@epicenter/auth` `Account`) reaches: `repository`, `<owner>/<name>` where
 * `<owner>` is a person's handle (`~` for the account's own), by default
 * `~/<contract name>`. A version is the Git blob id on `main`. A server that
 * cannot be reached, or that refuses this account the repository, is
 * `Unavailable` on each call, never a throw; a contract that is not well
 * formed, or a `repository` that names none, throws here, at once.
 */
export function openRemote<TContract extends Contract>(
	contract: TContract,
	{
		account,
		repository,
	}: { account: RemoteAccount; repository?: `${string}/${string}` },
): Client<TContract> {
	return createRemoteClient(contract, account, repository);
}
