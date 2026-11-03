/**
 * Where the Epicenter app keeps what the CLI reads and writes on this
 * machine, by the app's own rule (`DesktopPaths::resolve` in
 * `apps/epicenter/src-tauri/src/desktop_paths.rs`), so the CLI in a terminal
 * and the CLI the app runs read and write the same places.
 *
 * ```txt
 * <folderDir>/<name>/                        a data folder `epicenter clone` makes by default
 * <dataDir>/auth/<grant>.lock                the lock a grant refreshes under (auth.ts)
 * ~/.local/bin/epicenter                     the link Git's configuration runs (install-command.ts)
 * ```
 *
 * The shell sets `EPICENTER_ENVIRONMENT` when it runs the CLI. A terminal
 * invocation defaults to production. `EPICENTER_DATA_DIR` still names the
 * shell's application data directory; no variable replaces the library root.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** The release app's identifier, which names its platform directories. */
const IDENTIFIER = 'so.epicenter';

export type AppPaths = {
	/** The library root: where `epicenter clone` puts a folder. */
	readonly folderDir: string;
	/** Machine state worth keeping, including sign-in locks. */
	readonly dataDir: string;
	/**
	 * The `epicenter` every Git configuration Epicenter writes runs, and a
	 * terminal finds on `PATH`: a link to the binary the app bundles.
	 */
	readonly commandLink: string;
};

type Environment = Readonly<Record<string, string | undefined>>;

/** `variable` when set, refused unless absolute; otherwise `fallback()`. */
function directory(
	env: Environment,
	variable: string,
	fallback: () => string,
): string {
	const value = env[variable];
	if (value === undefined || value === '') return fallback();
	if (!isAbsolute(value))
		throw new Error(`${variable} must be an absolute path, not '${value}'.`);
	return value;
}

/** The paths the CLI uses, from `env` (the process's by default). */
export function resolveAppPaths(
	env: Environment = process.env,
	home: string = homedir(),
): AppPaths {
	const environment = env.EPICENTER_ENVIRONMENT || 'production';
	if (environment !== 'production' && environment !== 'development')
		throw new Error(`Unknown EPICENTER_ENVIRONMENT: '${environment}'.`);
	return {
		// Tauri's `app_local_data_dir` on macOS.
		dataDir: directory(env, 'EPICENTER_DATA_DIR', () =>
			join(
				home,
				'Library',
				'Application Support',
				environment === 'development' ? `${IDENTIFIER}.dev` : IDENTIFIER,
			),
		),
		folderDir: join(
			home,
			environment === 'development' ? 'Epicenter Dev' : 'Epicenter',
		),
		commandLink: join(home, '.local', 'bin', 'epicenter'),
	};
}
