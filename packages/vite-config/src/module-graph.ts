import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * A test timeout for `bundledModules`. Each call runs a Vite production build
 * of the app's resolution graph. It takes under a second alone, but
 * `bun run check` tests every package at once, and on CI's 4-vCPU runner one
 * build outlasted bun's default 5s.
 */
export const BUNDLE_TIMEOUT = 30_000;

/**
 * Every module a build of `entry` pulls in, as paths, resolved the way the
 * app's `vite.config.ts` resolves its build. A dropped alias fails no build,
 * because resolution falls back silently, so a bundle test reads this list to
 * prove what a build carries.
 *
 * The build runs in its own process (`scripts/module-graph.ts`), which
 * imports the app's `vite.config.ts` from the app's folder.
 */
export function bundledModules(
	appDir: string,
	entry: string,
): Promise<string[]> {
	const script = fileURLToPath(
		new URL('../scripts/module-graph.ts', import.meta.url),
	);
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[script, appDir, entry],
			{ cwd: appDir, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(`Bundling ${entry} failed:\n${stderr}`));
				else resolve(JSON.parse(stdout) as string[]);
			},
		);
	});
}
