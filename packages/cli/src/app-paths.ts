/**
 * Where Epicenter keeps installed apps on this machine, by the desktop
 * shell's rule (`DesktopPaths::resolve` in
 * `apps/epicenter/src-tauri/src/app_data.rs`), so the CLI in a terminal and
 * the CLI the app runs read and write the same places.
 *
 * ```txt
 * <folderDir>/Apps/<app-id>/                 a full clone of the app's repository
 * <dataDir>/approvals.json                   { [appId]: { commit, approvedAt } }
 * <cacheDir>/builds/<app-id>/<commit>/       the built bundle the app window loads
 * ```
 *
 * Each directory is its environment variable when set, which must be an
 * absolute path, and otherwise the release app's: `so.epicenter`'s platform
 * directories and `~/Epicenter`. The shell sets all three when it runs the
 * CLI, so a development build's CLI uses `so.epicenter.dev` and
 * `~/Epicenter Dev` as the shell does.
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
	/** Built bundles, at `<app-id>/<commit>/`. */
	readonly buildsDir: string;
	/** Which app commits may run on this machine. */
	readonly approvalsFile: string;
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

/** Tauri's `app_local_data_dir` and `app_cache_dir` parents for this platform. */
function platformDirectories(env: Environment, home: string) {
	if (process.platform === 'darwin')
		return {
			data: join(home, 'Library', 'Application Support'),
			cache: join(home, 'Library', 'Caches'),
		};
	if (process.platform === 'win32') {
		const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
		return { data: local, cache: local };
	}
	return {
		data: env.XDG_DATA_HOME || join(home, '.local', 'share'),
		cache: env.XDG_CACHE_HOME || join(home, '.cache'),
	};
}

/** The paths installing apps uses, from `env` (the process's by default). */
export function resolveAppPaths(
	env: Environment = process.env,
	home: string = homedir(),
): AppPaths {
	const platform = platformDirectories(env, home);
	const dataDir = directory(env, 'EPICENTER_DATA_DIR', () =>
		join(platform.data, IDENTIFIER),
	);
	const folderDir = directory(env, 'EPICENTER_FOLDER_DIR', () =>
		join(home, FOLDER_NAME),
	);
	const cacheDir = directory(env, 'EPICENTER_CACHE_DIR', () =>
		join(platform.cache, IDENTIFIER),
	);
	return {
		appsDir: join(folderDir, APPS_DIRECTORY),
		buildsDir: join(cacheDir, 'builds'),
		approvalsFile: join(dataDir, 'approvals.json'),
		cacheDir,
	};
}
