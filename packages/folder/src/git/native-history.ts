/**
 * A directory folder's history over the system `git` this process runs
 * (`native-backend.ts`): the Bun host's, and so the `epicenter` CLI's, which
 * runs it for desktop pages (ADR-0559). Git's own configuration decides the
 * remote (`remote.origin.url`, on `main`) and the author (`user.name` and
 * `user.email`, with `author` for whichever is missing).
 */
import type { LockingStorage } from '../boundary.js';
import type {
	HistoryReply,
	HistoryRequest,
	HistoryResults,
} from '../history-wire.js';
import { holdingHistoryLock } from '../native/directory.js';
import { executeHistoryRequest } from './history.js';
import type { GitCredentials } from './http.js';
import {
	createNativeGitBackend,
	type NativeGitHost,
} from './native-backend.js';
import type { Author } from './objects.js';

export async function runNativeHistory<TRequest extends HistoryRequest>({
	rootPath,
	host,
	boundary,
	author,
	credentials,
	initProblem,
	request,
	signal,
}: {
	readonly rootPath: string;
	/** The system `git` in `rootPath`, and the host's file system. */
	readonly host: NativeGitHost;
	/** The folder's files, which Sync publishes under their save lock. */
	readonly boundary: LockingStorage;
	/** Who commits, where Git's configuration does not say. */
	readonly author: Author;
	/** Asked before each push and fetch; see `GitCredentials`. */
	readonly credentials?: GitCredentials;
	/** Why the first commit of a folder with no repository must not create one here. */
	readonly initProblem?: () => Promise<string | undefined>;
	request: TRequest;
	signal?: AbortSignal;
}): Promise<HistoryReply<HistoryResults[TRequest['op']]>> {
	const commits = request.op === 'saveVersion' || request.op === 'sync';
	const configured = async (key: string) => {
		const { code, stdout } = await host.run(['config', '--get', key], {
			allowFailure: true,
		});
		const value = new TextDecoder().decode(stdout).trim();
		return code === 0 && value !== '' ? value : undefined;
	};
	// The person's own Git identity, read once the repository exists.
	let identity = author;
	const readIdentity = async () => {
		identity = {
			name: (await configured('user.name')) ?? author.name,
			email: (await configured('user.email')) ?? author.email,
		};
	};
	// Repository creation happens only during the request, under its history lock.
	const backend = await createNativeGitBackend({
		root: rootPath,
		branch: 'main',
		host,
		credentials,
		initialized: readIdentity,
		initProblem,
	});
	if (
		commits &&
		(await host.files.lstat(`${rootPath}/.git/HEAD`)) !== undefined
	)
		await readIdentity();
	const execute = () =>
		executeHistoryRequest(
			{ backend, boundary, getAuthor: () => identity, signal },
			request,
		);
	return commits ? holdingHistoryLock(rootPath, execute) : execute();
}
