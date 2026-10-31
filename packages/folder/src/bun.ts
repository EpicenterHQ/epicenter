/**
 * `@epicenter/folder/bun`: the system `git` runner the CLI's sync verbs use,
 * and where a folder keeps its unfinished writes, which sync never commits.
 * Git is outside a folder's lifetime.
 */

export {
	basicAuthorization,
	endGitCommands,
	type GitCredentials,
	runGit,
} from './git/native-host.js';
export { STATE_DIRECTORY } from './state.js';
