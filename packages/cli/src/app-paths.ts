/**
 * Where Epicenter keeps installed apps on this machine, by the desktop
 * shell's rule (`DesktopPaths::resolve` in
 * `apps/epicenter/src-tauri/src/app_data.rs`), so the CLI in a terminal and
 * the CLI the app runs read and write the same places.
 *
 * ```txt
 * <folderDir>/Apps/<app-id>/                 a full clone of the app's repository
 * <dataDir>/approvals.json                   { [appId]: { commit, approvedAt } }
 * <dataDir>/auth/<grant>.lock                the lock a grant refreshes under (auth.ts)
 * ~/.local/bin/epicenter                     the link Git's configuration runs (install-command.ts)
 * <cacheDir>/builds/<app-id>/<commit>/       the built bundle the app window loads
 * ```
 *
 * Each directory is its environment variable when set, which must be an
 * absolute path, and otherwise the release app's: `so.epicenter` under
 * macOS's `~/Library` and `~/Epicenter`. Epicenter ships for macOS only
 * (ADR-0567). The shell sets all three when it runs the CLI, so a
 * development build's CLI uses `so.epicenter.dev` and `~/Epicenter Dev` as
 * the shell does. The command link is one per person, whichever build runs.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** The release app's identifier, which names its platform directories. */
const IDENTIFIER = 'so.epicenter';
/** The release app's folder under the home directory. */
const FOLDER_NAME = 'Epicenter';
/** The directory under the folder root holding installed apps' sources. */
export const APPS_DIRECTORY = 'Apps';

export type AppPaths = {
	/** One repository per installed app, at `<app-id>/`. */
	readonly appsDir: string;
	/** The Epicenter folder: `Apps/` and Epicenter's own `so.epicenter/`. */
	readonly folderDir: string;
	/** Built bundles, at `<app-id>/<commit>/`. */
	readonly buildsDir: string;
	/** Which app commits may run on this machine. */
	readonly approvalsFile: string;
	/** Machine state worth keeping: approvals and the sign-in locks. */
	readonly dataDir: string;
	/**
	 * The `epicenter` every Git configuration Epicenter writes runs, and a
	 * terminal finds on `PATH`: a link to the binary the app bundles.
	 */
	readonly commandLink: string;
	/** Disposable machine state: builds, the work lock, and the `bun` link. */
	readonly cacheDir: string;
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

/** The paths installing apps and signing in use, from `env` (the process's by default). */
export function resolveAppPaths(
	env: Environment = process.env,
	home: string = homedir(),
): AppPaths {
	// Tauri's `app_local_data_dir` and `app_cache_dir` on macOS.
	const dataDir = directory(env, 'EPICENTER_DATA_DIR', () =>
		join(home, 'Library', 'Application Support', IDENTIFIER),
	);
	const folderDir = directory(env, 'EPICENTER_FOLDER_DIR', () =>
		join(home, FOLDER_NAME),
	);
	const cacheDir = directory(env, 'EPICENTER_CACHE_DIR', () =>
		join(home, 'Library', 'Caches', IDENTIFIER),
	);
	return {
		appsDir: join(folderDir, APPS_DIRECTORY),
		folderDir,
		buildsDir: join(cacheDir, 'builds'),
		approvalsFile: join(dataDir, 'approvals.json'),
		dataDir,
		commandLink: join(home, '.local', 'bin', 'epicenter'),
		cacheDir,
	};
}
