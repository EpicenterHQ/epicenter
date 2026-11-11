/**
 * An app's view (ADR-0860): what its `ui/` builds to, in `ui/dist/`, which
 * `epicenter serve` serves at `/<app>/`. `epicenter build`, `new --from`, and
 * `update` build it with the Bun that runs `epicenter`; the compiled
 * `epicenter` is Bun itself when `BUN_BE_BUN=1` is set, so a computer needs no
 * other program.
 *
 * - When `ui/package.json` has a `build` script, the app's code (what Git
 *   tracks or would track, minus `data/`) is copied to a staging folder,
 *   `ui/` installs there from its committed `bun.lock`, and the script runs
 *   there. It must write `ui/dist/`.
 * - Otherwise, when `ui/index.html` exists, Bun's bundler bundles it, with
 *   `@epicenter/app/client` supplied by this command, so one `index.html`
 *   and the files beside it are a view with no `package.json`.
 *
 * The staging folder sits beside the app as `.<app>-build-*`, which no
 * listing reads as an app, on the same volume so the finished `dist/`
 * replaces the last one by rename. `serve` never answers from half a build,
 * a failed build leaves the last view in place, and nothing appears in the
 * app's folder while it builds.
 */
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { COMPILED } from './child.ts';
import { checkedGit } from './git.ts';

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
 * Copy the app's code into `to`: every file Git tracks or would track, so
 * ignored output such as `node_modules/` and `ui/dist/` stays behind, and
 * nothing under `data/`, which is records (ADR-0876).
 */
async function copyCode(folder: string, to: string) {
	const listed = await checkedGit(folder, [
		'ls-files',
		'-z',
		'--cached',
		'--others',
		'--exclude-standard',
	]);
	const paths = new Set(listed.split('\0').filter(Boolean));
	for (const path of paths) {
		if (path.startsWith('data/')) continue;
		await mkdir(dirname(join(to, path)), { recursive: true });
		try {
			await copyFile(join(folder, path), join(to, path));
		} catch (error) {
			// Tracked but deleted, or a submodule's folder: not code to build.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'EISDIR') throw error;
		}
	}
}

/** Install `ui/` in the staged copy and run its `build`; returns its `dist/`. */
async function runBuildScript(folder: string, staging: string) {
	const code = join(staging, 'code');
	await copyCode(folder, code);
	const ui = join(code, 'ui');
	await runBun(
		ui,
		(await exists(join(ui, 'bun.lock')))
			? ['install', '--frozen-lockfile']
			: ['install'],
	);
	await runBun(ui, ['--bun', 'run', 'build']);
	return join(ui, 'dist');
}

/** Bundle `ui/index.html` with Bun into the staging folder; returns its output. */
async function bundleIndex(folder: string, staging: string) {
	const client = Bun.fileURLToPath(import.meta.resolve('@epicenter/app/client'));
	const outdir = join(staging, 'dist');
	const result = await Bun.build({
		entrypoints: [join(folder, 'ui', 'index.html')],
		outdir,
		minify: true,
		throw: false,
		plugins: [
			{
				name: '@epicenter/app/client',
				setup(build) {
					build.onResolve({ filter: /^@epicenter\/app\/client$/ }, () => ({
						path: client,
					}));
				},
			},
		],
	});
	if (!result.success)
		throw new Error(
			`bundling ui/index.html failed: ${result.logs.map(String).join('\n')}`,
		);
	return outdir;
}

/**
 * Build `folder`'s view into `ui/dist/`. Returns false when `ui/` has neither
 * a `build` script nor an `index.html`, so there is nothing to build; throws
 * with the build's own message when it fails, leaving the last view in place.
 */
export async function buildUi(folder: string): Promise<boolean> {
	const ui = join(folder, 'ui');
	const script = await hasBuildScript(ui);
	if (!script && !(await exists(join(ui, 'index.html')))) return false;
	const staging = await mkdtemp(
		join(dirname(folder), `.${basename(folder)}-build-`),
	);
	try {
		const built = script
			? await runBuildScript(folder, staging)
			: await bundleIndex(folder, staging);
		if (!(await exists(join(built, 'index.html'))))
			throw new Error(
				`ui/'s build wrote no ui/dist/index.html; its build must write ui/dist/`,
			);
		const view = join(folder, VIEW);
		const last = join(staging, 'last');
		const hadView = await exists(view);
		if (hadView) await rename(view, last);
		try {
			await rename(built, view);
		} catch (error) {
			if (hadView) await rename(last, view);
			throw error;
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	return true;
}
