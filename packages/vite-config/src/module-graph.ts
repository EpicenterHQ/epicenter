import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Every module a folder app's pages load before any `import()`: a
 * production build of every page source under the app's `src/`, resolved
 * the way the app's `vite.config.ts` resolves its build, keeping only the
 * entries' chunks and the chunks they import statically. A module the page
 * loads on demand, such as a capability's desktop implementation, is left
 * out. A static import of a module the page should load on demand breaks no
 * build, so a test reads this list to prove what a first load carries.
 *
 * The build runs in its own process (`scripts/first-load.ts`), which
 * imports the app's `vite.config.ts` from the app's folder.
 */
export function firstLoadModules(appDir: string): Promise<string[]> {
	const script = fileURLToPath(
		new URL('../scripts/first-load.ts', import.meta.url),
	);
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[script, appDir],
			{ cwd: appDir, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error)
					reject(new Error(`Building ${appDir}'s pages failed:\n${stderr}`));
				else resolve(JSON.parse(stdout) as string[]);
			},
		);
	});
}
