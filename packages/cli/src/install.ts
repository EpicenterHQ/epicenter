/**
 * The two Bun commands `init` and `new` run for the person. A home is one Bun
 * workspace whose `package.json` depends on `@epicenter/cli` and
 * `@epicenter/app` and takes each `apps/<app>/code` as a package, so one
 * `bun install` at its top, one `bun.lock` and one `node_modules/` serve the
 * command and every app. An app's UI is what its own `bun run build` writes
 * to `code/ui/dist/`; `serve` only serves it. Epicenter has no install or
 * build command: the person runs Bun's. A call never installs or builds.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';

/** The command a person runs to install the home at `folder`. */
export const installNext = (folder: string) => `cd ${folder} && bun install`;

/** The command a person runs to build the UI of the app whose code is `folder`. */
export const buildNext = (folder: string) => `cd ${folder} && bun run build`;

/** Why a Bun command failed, and the command that tries it again. */
export type BunProblem = { message: string; next: string };

/**
 * Run `bun install` in `folder`, the top of a home, with the Bun that runs
 * this command. Answers what went wrong, or undefined when it installed.
 */
export async function installHome(
	folder: string,
): Promise<BunProblem | undefined> {
	const next = installNext(folder);
	if (!existsSync(join(folder, 'package.json')))
		return {
			message: `${folder} has no package.json. A home is a Bun workspace: its package.json lists "workspaces": ["apps/*/code"] and depends on @epicenter/cli and @epicenter/app. Write it, then install.`,
			next,
		};
	return runBun(folder, ['install'], next);
}

/**
 * Run the app's own `bun run build` in its code `folder`, which writes its UI
 * to `ui/dist/`, when its `package.json` has a `build` script. Answers what
 * went wrong, or undefined when it built or has nothing to build.
 */
export async function buildApp(
	folder: string,
): Promise<BunProblem | undefined> {
	const manifest = await Bun.file(join(folder, 'package.json'))
		.json()
		.catch(() => undefined);
	if (typeof manifest?.scripts?.build !== 'string') return undefined;
	return runBun(folder, ['run', 'build'], buildNext(folder));
}

/** Run the Bun that runs this command with `args` in `cwd`, answering its failure. */
async function runBun(
	cwd: string,
	args: string[],
	next: string,
): Promise<BunProblem | undefined> {
	try {
		const child = Bun.spawn([process.execPath, ...args], {
			cwd,
			env: process.env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (code === 0) return undefined;
		return {
			message:
				stderr.trim() ||
				stdout.trim() ||
				`bun ${args.join(' ')} exited with code ${code}`,
			next,
		};
	} catch (cause) {
		return { message: extractErrorMessage(cause), next };
	}
}
