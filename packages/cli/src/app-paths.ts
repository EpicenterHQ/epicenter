/**
 * Where the CLI reads and writes on this machine: the Epicenter folder, the
 * same one the Epicenter app shows (`DesktopPaths::resolve` in
 * `apps/epicenter/src-tauri/src/desktop_paths.rs`), and a directory for its
 * sign-in's lock, which it keeps beside the app's data. The app neither runs
 * nor sets anything for the CLI (ADR-0793).
 *
 * ```txt
 * <folderDir>/<name>/                        a folder `epicenter clone` makes
 * <dataDir>/auth/device.lock                 the lock the sign-in refreshes under (auth.ts)
 * ```
 *
 * `EPICENTER_ENVIRONMENT=development` selects development's places; without
 * it, a binary uses the environment `scripts/compile.ts` embedded, and a run
 * from source production's. `EPICENTER_DATA_DIR`, when set,
 * moves the lock's directory, as tests and a sandboxed terminal do; no
 * variable replaces the Epicenter folder.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
	EPICENTER_BUNDLE_IDENTIFIER,
	epicenterDataRoot,
} from '@epicenter/definition/site/app-data';

/** The environment `scripts/compile.ts` embeds in a compiled binary. */
declare const __EPICENTER_BUILD_ENVIRONMENT__: string;

export type AppPaths = {
	/** The Epicenter folder: where `epicenter clone` puts a folder. */
	readonly folderDir: string;
	/** Machine state worth keeping: the sign-in's lock. */
	readonly dataDir: string;
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
	const environment =
		env.EPICENTER_ENVIRONMENT ||
		(typeof __EPICENTER_BUILD_ENVIRONMENT__ === 'undefined'
			? 'production'
			: __EPICENTER_BUILD_ENVIRONMENT__);
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
	};
}
