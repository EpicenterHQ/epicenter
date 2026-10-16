/**
 * A directory folder's history over the system `git` this process runs
 * (`native-backend.ts`): the Bun host's, and so the `epicenter` CLI's, which
 * runs it for desktop pages (ADR-0559). Git's own configuration decides the
 * remote (`remote.origin.url`, on `main`) and the author (`user.name` and
 * `user.email`, with `author` for whichever is missing).
 */
import type { DirectoryHistory } from '../directory-adapter.js';
import { createHistory, type History } from './history.js';
import type { GitCredentials } from './http.js';
import {
	createNativeGitBackend,
	type NativeGitHost,
} from './native-backend.js';
import type { Author } from './objects.js';

export function nativeHistory({
	rootPath,
	host,
	author,
	credentials,
	initProblem,
	commits = true,
}: {
	readonly rootPath: string;
	/** The system `git` in `rootPath`, and the host's file system. */
	readonly host: NativeGitHost;
	/** Who commits, where Git's configuration does not say. */
	readonly author: Author;
	/** Asked before each push and fetch; see `GitCredentials`. */
	readonly credentials?: GitCredentials;
	/** Why the first commit of a folder with no repository must not create one here. */
	readonly initProblem?: () => Promise<string | undefined>;
	/**
	 * Whether this history may commit. Without it the person's Git identity
	 * is not read: two `git` runs a status or a log does not need.
	 */
	readonly commits?: boolean;
}): DirectoryHistory<History> {
	const configured = async (key: string) => {
		const { code, stdout } = await host.run(['config', '--get', key], {
			allowFailure: true,
		});
		const value = new TextDecoder().decode(stdout).trim();
		return code === 0 && value !== '' ? value : undefined;
	};
	return async ({ boundary, landed }) => {
		// The person's own Git identity, read once the repository exists.
		let identity = author;
		const readIdentity = async () => {
			identity = {
				name: (await configured('user.name')) ?? author.name,
				email: (await configured('user.email')) ?? author.email,
			};
		};
		// Two handles that commit a new folder at once may both run
		// `git init`; the backend runs it again when the race fails it.
		// Each handle orders its own index and branch work; other handles and
		// processes meet Git's own lock files and the branch's
		// compare-and-swap.
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
		return (prepared) =>
			createHistory({
				backend,
				boundary,
				// Read at each commit, so a repository the first commit creates
				// commits as the person's identity too.
				author: {
					get name() {
						return identity.name;
					},
					get email() {
						return identity.email;
					},
				},
				definition: prepared,
				landed,
			});
	};
}
