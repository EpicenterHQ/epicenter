/**
 * Building an app's UI (ADR-0860, ADR-0866). An app's `ui/` is a project of
 * its own whose `build` script writes `../.cache/ui/`, which `epicenter serve`
 * serves at `/<app>/`. `epicenter new --from` and `epicenter update` build it
 * with the Bun that runs `epicenter`: the compiled `epicenter` is Bun itself
 * when `BUN_BE_BUN=1` is set, so a computer needs no other program.
 *
 * A build that fails leaves the last UI that built in place, so a broken
 * update never takes a working UI away. A build changes nothing Git tracks:
 * it installs from `ui/bun.lock` when the starter commits one, and writes no
 * lockfile otherwise, so the app stays clean for the next update.
 */
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPILED } from './child.ts';

/** Where an app's built UI lives, relative to its folder. */
export const BUILT_UI = join('.cache', 'ui');

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Run Bun, the program running now (itself when compiled, else the `bun` it
 * runs under), with `args` in `cwd`, throwing with its output when it fails.
 */
async function runBun(cwd: string, args: string[]) {
	const child = Bun.spawn([process.execPath, ...args], {
		cwd,
		env: { ...process.env, ...(COMPILED ? { BUN_BE_BUN: '1' } : {}) },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(
			`bun ${args.join(' ')} exited ${code}: ${(stderr || stdout).trim()}`,
		);
}

/**
 * Install the packages of `folder`'s `ui/` and build it into `.cache/ui/`.
 * Returns false when the app has no `ui/package.json`, so nothing was built;
 * throws with the build's own message when it fails, after putting the last
 * built UI back.
 */
export async function buildUi(folder: string): Promise<boolean> {
	const ui = join(folder, 'ui');
	if (!(await exists(join(ui, 'package.json')))) return false;
	const built = join(folder, BUILT_UI);
	const last = `${built}.last`;
	await rm(last, { recursive: true, force: true });
	if (await exists(built)) await rename(built, last);
	try {
		// Installing never changes the app's files: the starter's committed
		// lockfile is followed exactly, and without one none is written.
		await runBun(ui, [
			'install',
			(await exists(join(ui, 'bun.lock'))) ? '--frozen-lockfile' : '--no-save',
		]);
		await runBun(ui, ['--bun', 'run', 'build']);
		if (!(await exists(join(built, 'index.html'))))
			throw new Error(
				`ui/'s build wrote no ${BUILT_UI}/index.html; its build must write ../.cache/ui/`,
			);
	} catch (error) {
		await rm(built, { recursive: true, force: true });
		if (await exists(last)) await rename(last, built);
		throw error;
	}
	await rm(last, { recursive: true, force: true });
	return true;
}
