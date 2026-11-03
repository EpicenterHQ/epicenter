/**
 * Where the Epicenter app keeps what the CLI reads and writes on this
 * machine, by the app's own rule (`DesktopPaths::resolve` in
 * `apps/epicenter/src-tauri/src/desktop_paths.rs`), so the CLI in a terminal
 * and the CLI the app runs read and write the same places.
 *
 * ```txt
 * <folderDir>/<site-derived path>/           a data folder `epicenter clone` makes by default
 * <dataDir>/auth/<grant>.lock                the lock a grant refreshes under (auth.ts)
 * ~/.epicenter/bin/epicenter                 the engine Git's configuration runs
 * ```
 *
 * The shell sets `EPICENTER_ENVIRONMENT` when it runs the CLI. A terminal
 * invocation defaults to production. `EPICENTER_DATA_DIR` still names the
 * shell's application data directory; no variable replaces the library root.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
	EPICENTER_BUNDLE_IDENTIFIER,
	epicenterDataRoot,
} from '@epicenter/constants/app-data';

export type AppPaths = {
	/** The library root: where `epicenter clone` puts a folder. */
	readonly folderDir: string;
	/** Machine state worth keeping, including sign-in locks. */
	readonly dataDir: string;
	/** The engine every Git configuration Epicenter writes runs. */
	readonly engine: string;
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
	executable: string = process.execPath,
): AppPaths {
	const devEngine = join(
		home,
		'.epicenter-dev',
		'bin',
		process.platform === 'win32' ? 'epicenter.exe' : 'epicenter',
	);
	const environment =
		env.EPICENTER_ENVIRONMENT ||
		(resolve(executable) === devEngine ? 'development' : 'production');
	if (environment !== 'production' && environment !== 'development')
		throw new Error(`Unknown EPICENTER_ENVIRONMENT: '${environment}'.`);
	return {
		dataDir: directory(env, 'EPICENTER_DATA_DIR', () =>
			epicenterDataRoot(
				{ env, platform: process.platform, homeDir: home },
				environment === 'development'
					? `${EPICENTER_BUNDLE_IDENTIFIER}.dev`
					: EPICENTER_BUNDLE_IDENTIFIER,
			),
		),
		folderDir: join(
			home,
			environment === 'development' ? 'Epicenter Dev' : 'Epicenter',
		),
		engine: join(
			home,
			environment === 'development' ? '.epicenter-dev' : '.epicenter',
			'bin',
			process.platform === 'win32' ? 'epicenter.exe' : 'epicenter',
		),
	};
}
