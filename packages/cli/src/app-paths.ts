/**
 * Where the Epicenter app keeps what the CLI reads and writes on this
 * machine, by the shared native rule (`DesktopPaths::resolve` in
 * `packages/tauri-plugin-epicenter-folder/src/defaults.rs`), so the CLI in a terminal and
 * the CLI the app runs read and write the same places.
 *
 * ```txt
 * <folderDir>/<name>/                        a data folder discovered by scanning
 * <dataDir>/folders.json                     added paths and the selected records location
 * <dataDir>/auth/<grant>.lock                the lock a grant refreshes under (auth.ts)
 * ~/.local/bin/epicenter                     the link Git's configuration runs (install-command.ts)
 * ```
 *
 * Each directory is its environment variable when set, which must be an
 * absolute path, and otherwise the release app's: `so.epicenter` under
 * macOS's `~/Library` and `~/Epicenter`. Epicenter ships for macOS only
 * (ADR-0567). The shell sets both when it runs the CLI, so a development
 * build's CLI uses `so.epicenter.dev` and `~/Epicenter Dev` as the shell
 * does. The command link is one per person, whichever build runs.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** The release app's identifier, which names its platform directories. */
const IDENTIFIER = 'so.epicenter';
/** The release app's folder under the home directory. */
const FOLDER_NAME = 'Epicenter';

export type AppPaths = {
	/** The scanned folder root; records default to its `so.epicenter/` child. */
	readonly folderDir: string;
	/** Machine state worth keeping, including folder choices and sign-in locks. */
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
	return {
		// Tauri's `app_local_data_dir` on macOS.
		dataDir: directory(env, 'EPICENTER_DATA_DIR', () =>
			join(home, 'Library', 'Application Support', IDENTIFIER),
		),
		folderDir: directory(env, 'EPICENTER_FOLDER_DIR', () =>
			join(home, FOLDER_NAME),
		),
		commandLink: join(home, '.local', 'bin', 'epicenter'),
	};
}
