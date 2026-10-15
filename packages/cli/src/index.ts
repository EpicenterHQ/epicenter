/**
 * `@epicenter/cli`: the `epicenter` command line as one function, for the
 * binary that composes it, and the shapes `epicenter app … --json` prints,
 * for the Folders window that reads them.
 */
export { runCli } from './cli.ts';
export type {
	AppState,
	InstalledApp,
	RepositoryApp,
	Review,
} from './installed-apps.ts';
