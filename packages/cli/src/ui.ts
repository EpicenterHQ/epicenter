/**
 * An app's view (ADR-0860): what its `ui/` builds to, in `ui/dist/`, which
 * `epicenter serve` serves at `/<app>/`. `ui/dist/` is a cache of the code
 * repository's `HEAD`: it is stamped with the commit it was built from, and
 * `serve` rebuilds it in the background when `HEAD` moves, serving the last
 * view meanwhile. So a change to the view shows once it is committed, by
 * whoever made it or by `serve`'s snapshot, and nobody has to remember to
 * build. `epicenter build` builds now and shows the build's errors.
 *
 * A build checks out `HEAD` into a detached worktree beside the app, as
 * `.<app>-build-*`, which no listing reads as an app. It builds exactly the
 * commit, with Git LFS files as files, and never the working tree:
 *
 * - When `ui/package.json` has a `build` script, `ui/` installs from its
 *   committed `bun.lock` and the script runs with `EPICENTER_BASE=/<app>`,
 *   the path the view is served at. It must write `ui/dist/`.
 * - Otherwise, when `ui/index.html` exists, Bun's bundler bundles it, so
 *   one `index.html` and the files beside it are a view with no
 *   `package.json`.
 *
 * Before either, `node_modules/@epicenter/app` in the worktree and in the app's
 * folder links to this command's own copy (`linkAppPackage`), so a view never
 * installs it and its client always matches the `serve` that answers it.
 * Both run with the Bun that runs `epicenter`; the compiled `epicenter` is
 * Bun itself when `BUN_BE_BUN=1` is set. The finished `dist/` replaces
 * `ui/dist/` by rename, on the same volume, so `serve` never answers from half
 * a build, and a failed build leaves the last view in place.
 */
import {
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import packageJson from '../package.json' with { type: 'json' };
import { COMPILED } from './child.ts';
import { checkedGit, git } from './git.ts';
import { writeErr } from './output.ts';

/**
 * The `@epicenter/app` this command runs, whose `/client` a view must speak
 * to the `serve` that answers it: its package folder, two up from its entry.
 */
const APP_PACKAGE = dirname(
	dirname(Bun.fileURLToPath(import.meta.resolve('@epicenter/app'))),
);

/**
 * Make `folder/node_modules/@epicenter/app` this command's own, as `epicenter`
 * supplies it to every `epicenter.ts` it runs (ADR-0857), so a view's build,
 * `bun run dev` in `ui/`, and an editor's types all resolve it to the copy
 * that `serve` speaks, and no app installs it. `node_modules/` is ignored.
 */
export async function linkAppPackage(folder: string) {
	const link = join(folder, 'node_modules', '@epicenter', 'app');
	try {
		if ((await readlink(link)) === APP_PACKAGE) return;
	} catch {}
	await rm(link, { recursive: true, force: true });
	await mkdir(dirname(link), { recursive: true });
	await symlink(APP_PACKAGE, link, 'dir');
}

/** Where an app's view lives, relative to its folder. */
export const VIEW = join('ui', 'dist');

/**
 * The stamp inside `ui/dist/`: the commit the view was built from and the
 * `epicenter` that built it, whose client a bundled view carries. `serve`
 * never serves a name that starts with `.`.
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

/**
 * How `commit`'s `ui/` builds, read from the commit without checking it out:
 * by its `build` script, by bundling its `index.html`, or not at all.
 */
async function viewSource(
	folder: string,
	commit: string,
): Promise<'script' | 'index' | undefined> {
	const manifest = await git(folder, ['show', `${commit}:ui/package.json`]);
	if (manifest.code === 0) {
		const parsed: { scripts?: { build?: unknown } } | null = JSON.parse(
			manifest.stdout,
		);
		if (typeof parsed?.scripts?.build === 'string') return 'script';
	}
	const index = await git(folder, [
		'cat-file',
		'-e',
		`${commit}:ui/index.html`,
	]);
	return index.code === 0 ? 'index' : undefined;
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

/** Install `ui/` and run its `build`; returns the `dist/` it wrote. */
async function runBuildScript(app: string, ui: string) {
	await runBun(
		ui,
		(await exists(join(ui, 'bun.lock')))
			? ['install', '--frozen-lockfile']
			: ['install'],
	);
	await runBun(ui, ['--bun', 'run', 'build'], { EPICENTER_BASE: `/${app}` });
	return join(ui, 'dist');
}

/**
 * Bundle `ui/index.html` with Bun; returns the folder it wrote. Its
 * `@epicenter/app/client` resolves through the linked `node_modules`.
 */
async function bundleIndex(ui: string, outdir: string) {
	const result = await Bun.build({
		entrypoints: [join(ui, 'index.html')],
		outdir,
		minify: true,
		throw: false,
	});
	if (!result.success)
		throw new Error(
			`bundling ui/index.html failed: ${result.logs.map(String).join('\n')}`,
		);
	return outdir;
}

/** The code repository's `HEAD`, or undefined before its first commit. */
async function headOf(folder: string): Promise<string | undefined> {
	const head = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD']);
	return head.code === 0 ? head.stdout : undefined;
}

const stampFor = (commit: string) => `${commit}\n${packageJson.version}\n`;

/** Whether `ui/dist/` was built from `commit` by this `epicenter`. */
async function builtFrom(folder: string, commit: string) {
	try {
		return (
			(await readFile(join(folder, VIEW, STAMP), 'utf8')) === stampFor(commit)
		);
	} catch {
		return false;
	}
}

/**
 * Build the view of `HEAD` for the app `app`, whose folder is `folder`, into
 * `ui/dist/`, and answer the commit it was built from. Answers undefined when
 * there is nothing to build: no commit yet, or a `ui/` with neither a `build`
 * script nor an `index.html` at that commit. Throws with the build's own
 * message when it fails, leaving the last view in place.
 */
export async function buildView(
	app: string,
	folder: string,
): Promise<string | undefined> {
	const commit = await headOf(folder);
	if (!commit) return undefined;
	const source = await viewSource(folder, commit);
	if (!source) return undefined;
	const staging = await mkdtemp(
		join(dirname(folder), `.${basename(folder)}-build-`),
	);
	const code = join(staging, 'code');
	try {
		// A build stopped by a crash leaves a worktree Git still lists.
		await git(folder, ['worktree', 'prune']);
		await checkedGit(folder, ['worktree', 'add', '--detach', code, commit]);
		await linkAppPackage(code);
		await linkAppPackage(folder);
		const ui = join(code, 'ui');
		const built =
			source === 'script'
				? await runBuildScript(app, ui)
				: await bundleIndex(ui, join(staging, 'dist'));
		if (!(await exists(join(built, 'index.html'))))
			throw new Error(
				`ui/'s build wrote no ui/dist/index.html; its build must write ui/dist/`,
			);
		await writeFile(join(built, STAMP), stampFor(commit));
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
		return commit;
	} finally {
		await git(folder, ['worktree', 'remove', '--force', code]);
		await rm(staging, { recursive: true, force: true });
	}
}

/**
 * `serve`'s rebuilding: `refresh(app, folder)` builds in the background when
 * `ui/dist/` was not built from `HEAD`. One build runs per app at a time, and
 * a commit whose build failed is not tried again; its failure is written to
 * stderr once, and `epicenter build` shows it again.
 */
export function createViewRefresher() {
	const running = new Map<string, Promise<void>>();
	const failed = new Map<string, string>();
	const refresh = async (app: string, folder: string) => {
		const commit = await headOf(folder);
		if (!commit || failed.get(folder) === commit) return;
		if (await builtFrom(folder, commit)) return;
		try {
			if (!(await viewSource(folder, commit))) return;
			await buildView(app, folder);
			failed.delete(folder);
		} catch (error) {
			failed.set(folder, commit);
			writeErr(
				`${app}: the view of ${commit.slice(0, 7)} did not build, so the last one is served: ${extractErrorMessage(error)}\nRun: epicenter build ${app}`,
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
