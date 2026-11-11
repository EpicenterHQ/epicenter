/**
 * An app's UI (ADR-0860, ADR-0880): what its `ui/` builds to, in `ui/dist/`,
 * which `epicenter serve` serves at `/<app>/`. A UI runs as it sits on disk,
 * as the app's actions do: `ui/dist/` is a cache of `ui/`'s sources, stamped
 * with their fingerprint, and `serve` rebuilds it in the background when the
 * fingerprint changes, serving the last good build meanwhile. Committed or
 * not, an edit shows on the next page load after its build. `epicenter build`
 * builds now and shows the build's errors.
 *
 * The fingerprint is the path, size and modified time of every file under
 * `ui/` (but `ui/dist/`, any `node_modules/`, and names starting with `.`),
 * with the app's `package.json` and `bun.lock` and this `epicenter`'s version,
 * so an upgraded `epicenter` rebuilds every UI against its own client.
 *
 * An app is one Bun project, so a UI builds in the app's folder:
 *
 * - When the app's `package.json` has a `build` script, it runs with
 *   `EPICENTER_OUT` naming the folder to build into.
 * - Otherwise, when `ui/index.html` exists, Bun's bundler bundles it, so one
 *   `index.html` and the files beside it are a UI with no `package.json`.
 *
 * Either writes relative URLs, so a build is never told where it is served.
 * Neither installs: an app whose `package.json` names packages and that has
 * no `node_modules/` is not built until `epicenter install` installs them.
 * Before either, `node_modules/@epicenter/app` links to this command's own
 * (`linkAppPackage`), so a UI's client always matches the `serve` that
 * answers it. Both run with the Bun that runs `epicenter`. The finished build
 * replaces `ui/dist/` by rename, on the same volume, so `serve` never answers
 * from half a build, and a failed build leaves the last one in place.
 */
import {
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import packageJson from '../package.json' with { type: 'json' };
import { linkAppPackage } from './app-package.ts';
import { COMPILED } from './commands.ts';
import { writeErr } from './output.ts';

/** Where an app's built UI lives, relative to its folder. */
export const UI_DIST = join('ui', 'dist');

/**
 * The stamp inside `ui/dist/`: the fingerprint of the sources it was built
 * from. `serve` never serves a name that starts with `.`.
 */
const STAMP = '.epicenter-build';

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** The app's `package.json`, or undefined when it has none or it is not JSON. */
async function manifestOf(folder: string): Promise<
	| {
			scripts?: Record<string, unknown>;
			dependencies?: Record<string, unknown>;
			devDependencies?: Record<string, unknown>;
	  }
	| undefined
> {
	try {
		return JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * How the app's UI builds: by its `build` script, by bundling
 * `ui/index.html`, or not at all, when it has no `ui/` or neither.
 */
async function uiSource(folder: string): Promise<'script' | 'index' | undefined> {
	if (!(await exists(join(folder, 'ui')))) return undefined;
	const manifest = await manifestOf(folder);
	if (typeof manifest?.scripts?.build === 'string') return 'script';
	return (await exists(join(folder, 'ui', 'index.html'))) ? 'index' : undefined;
}

/** Why the app's UI cannot build until its packages are installed, or undefined when it can. */
async function missingPackages(app: string, folder: string) {
	const manifest = await manifestOf(folder);
	const names = {
		...manifest?.dependencies,
		...manifest?.devDependencies,
	};
	if (Object.keys(names).length === 0) return undefined;
	if (await exists(join(folder, 'node_modules'))) return undefined;
	return `the UI needs ${app}'s packages, which are not installed\nRun: epicenter install ${app}`;
}

/** Every file under `dir` the fingerprint covers, as `path size mtime` lines. */
async function sourceLines(dir: string, prefix: string): Promise<string[]> {
	const lines: string[] = [];
	let entries: import('node:fs').Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return lines;
	}
	for (const entry of entries) {
		const path = `${prefix}${entry.name}`;
		if (
			entry.name.startsWith('.') ||
			entry.name === 'node_modules' ||
			path === 'ui/dist'
		)
			continue;
		if (entry.isDirectory())
			lines.push(...(await sourceLines(join(dir, entry.name), `${path}/`)));
		else lines.push(await statLine(join(dir, entry.name), path));
	}
	return lines;
}

async function statLine(file: string, path: string) {
	try {
		const { size, mtimeMs } = await stat(file);
		return `${path}\0${size}\0${mtimeMs}`;
	} catch {
		return `${path}\0gone`;
	}
}

/** The fingerprint of the app's UI sources, as the stamp in `ui/dist/` records it. */
async function fingerprintOf(folder: string): Promise<string> {
	const lines = [
		...(await sourceLines(join(folder, 'ui'), 'ui/')),
		await statLine(join(folder, 'package.json'), 'package.json'),
		await statLine(join(folder, 'bun.lock'), 'bun.lock'),
	].sort();
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(`${packageJson.version}\n${lines.join('\n')}`);
	return hasher.digest('hex');
}

/** Whether `ui/dist/` was built from sources with `fingerprint`. */
async function builtFrom(folder: string, fingerprint: string) {
	try {
		return (await readFile(join(folder, UI_DIST, STAMP), 'utf8')) === fingerprint;
	} catch {
		return false;
	}
}

/**
 * Run Bun, the program running now (itself when compiled, else the `bun` it
 * runs under), with `args` in `cwd` and `env` added to this process's,
 * throwing with its output when it fails.
 */
async function runBun(
	cwd: string,
	args: string[],
	env: Record<string, string> = {},
) {
	const child = Bun.spawn([process.execPath, ...args], {
		cwd,
		env: {
			...process.env,
			...env,
			...(COMPILED ? { BUN_BE_BUN: '1' } : {}),
		},
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

/** Bundle `ui/index.html` with Bun into `outdir`. */
async function bundleIndex(folder: string, outdir: string) {
	const result = await Bun.build({
		entrypoints: [join(folder, 'ui', 'index.html')],
		outdir,
		minify: true,
		throw: false,
	});
	if (!result.success)
		throw new Error(
			`bundling ui/index.html failed: ${result.logs.map(String).join('\n')}`,
		);
}

/**
 * Build the UI of the app `app`, whose folder is `folder`, into `ui/dist/`
 * now, and answer whether there was one to build: false for an app with no
 * `ui/`, or a `ui/` with no `index.html` and no `build` script. Throws with
 * the build's own message when it fails, or when its packages are not
 * installed, leaving the last build in place.
 */
export async function buildUi(app: string, folder: string): Promise<boolean> {
	const source = await uiSource(folder);
	if (!source) return false;
	const missing = await missingPackages(app, folder);
	if (missing) throw new Error(missing);
	const fingerprint = await fingerprintOf(folder);
	const staging = await mkdtemp(
		join(dirname(folder), `.${basename(folder)}-build-`),
	);
	const built = join(staging, 'dist');
	try {
		await linkAppPackage(folder);
		if (source === 'script')
			await runBun(folder, ['--bun', 'run', 'build'], {
				EPICENTER_OUT: built,
			});
		else await bundleIndex(folder, built);
		if (!(await exists(join(built, 'index.html'))))
			throw new Error(
				'the build wrote no index.html into the folder EPICENTER_OUT names',
			);
		await writeFile(join(built, STAMP), fingerprint);
		const dist = join(folder, UI_DIST);
		const last = join(staging, 'last');
		const hadBuild = await exists(dist);
		if (hadBuild) await rename(dist, last);
		try {
			await rename(built, dist);
		} catch (error) {
			if (hadBuild) await rename(last, dist);
			throw error;
		}
		return true;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/**
 * `serve`'s rebuilding: `refresh(app, folder)` builds in the background when
 * `ui/dist/` was not built from the UI's sources as they are now. One build
 * runs per app at a time. Sources whose build failed are not tried again
 * until they change; the failure is written to stderr once, and
 * `epicenter build` shows it again. An app whose packages are not installed
 * is skipped, not failed, so `epicenter install` is all it takes.
 */
export function createUiRefresher() {
	const running = new Map<string, Promise<void>>();
	/** Each folder's fingerprint whose build failed, or that waits for an install. */
	const told = new Map<string, string>();
	const refresh = async (app: string, folder: string) => {
		if (!(await uiSource(folder))) return;
		const fingerprint = await fingerprintOf(folder);
		if (await builtFrom(folder, fingerprint)) return;
		const missing = await missingPackages(app, folder);
		if (missing) {
			if (told.get(folder) !== `missing ${fingerprint}`)
				writeErr(`${app}: ${missing}`);
			told.set(folder, `missing ${fingerprint}`);
			return;
		}
		if (told.get(folder) === fingerprint) return;
		try {
			await buildUi(app, folder);
			told.delete(folder);
		} catch (error) {
			told.set(folder, fingerprint);
			writeErr(
				`${app}: the UI did not build, so the last build is served: ${extractErrorMessage(error)}\nRun: epicenter build ${app}`,
			);
		}
	};
	return (app: string, folder: string): Promise<void> => {
		const now = running.get(folder);
		if (now) return now;
		const next = refresh(app, folder).finally(() => running.delete(folder));
		running.set(folder, next);
		return next;
	};
}
