/**
 * An app's view (ADR-0860, ADR-0866): whatever is in its `ui/dist/`, which
 * `epicenter serve` serves at `/<app>/`. When `ui/package.json` has a `build`
 * script, `ui/dist/` is that build's output; otherwise it holds files written
 * by hand, and there is nothing to build. `epicenter build`, `new --from`, and
 * `update` build it with the Bun that runs `epicenter`: the compiled
 * `epicenter` is Bun itself when `BUN_BE_BUN=1` is set, so a computer needs no
 * other program.
 *
 * A build that fails leaves the last view that built in place, so a broken
 * update never takes a working view away. The last view waits in a copy
 * outside the app, so nothing beside `ui/dist/` appears in the app while it
 * builds. A build changes nothing Git tracks: it installs from `ui/bun.lock`
 * when the starter commits one, and writes no lockfile otherwise, so the app
 * stays clean for the next update.
 */
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { COMPILED } from './child.ts';

/** Where an app's view lives, relative to its folder. */
export const VIEW = join('ui', 'dist');

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Whether `ui/package.json` has a `build` script; a missing file has none. */
async function hasBuildScript(ui: string): Promise<boolean> {
	let text: string;
	try {
		text = await readFile(join(ui, 'package.json'), 'utf8');
	} catch {
		return false;
	}
	const manifest: { scripts?: { build?: unknown } } | null = JSON.parse(text);
	return typeof manifest?.scripts?.build === 'string';
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
 * Install the packages of `folder`'s `ui/` and run its `build`, which must
 * write `ui/dist/index.html`. Returns false when `ui/package.json` has no
 * `build` script, so there is nothing to build; throws with the build's own
 * message when it fails, after putting the last view back.
 */
export async function buildUi(folder: string): Promise<boolean> {
	const ui = join(folder, 'ui');
	if (!(await hasBuildScript(ui))) return false;
	const view = join(folder, VIEW);
	const kept = (await exists(view))
		? join(await mkdtemp(join(tmpdir(), 'epicenter-view-')), 'dist')
		: undefined;
	if (kept) await cp(view, kept, { recursive: true });
	try {
		// Installing never changes the app's files: the starter's committed
		// lockfile is followed exactly, and without one none is written.
		await runBun(ui, [
			'install',
			(await exists(join(ui, 'bun.lock'))) ? '--frozen-lockfile' : '--no-save',
		]);
		await runBun(ui, ['--bun', 'run', 'build']);
		if (!(await exists(join(view, 'index.html'))))
			throw new Error(
				`ui/'s build wrote no ${VIEW}/index.html; its build must write ui/dist/`,
			);
	} catch (error) {
		await rm(view, { recursive: true, force: true });
		if (kept) await cp(kept, view, { recursive: true });
		throw error;
	} finally {
		if (kept) await rm(dirname(kept), { recursive: true, force: true });
	}
	return true;
}
