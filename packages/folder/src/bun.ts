/**
 * `@epicenter/folder/bun`: the system `git` runner the CLI's sync verbs use.
 * Git is outside a folder's lifetime.
 */

export {
	basicAuthorization,
	endGitCommands,
	type GitCredentials,
	runGit,
} from './git/native-host.js';
