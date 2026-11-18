/**
 * Installing a home. A home is one Bun workspace whose
 * `package.json` depends on `@epicenter/cli` and `@epicenter/app` and takes
 * each `apps/<app>/code` as a package, so one `bun install` at its top, one
 * `bun.lock` and one `node_modules/` serve the command and every app, and
 * `bun run build` there runs every app's own build into its `code/ui/dist/`.
 * Epicenter installs once, in `init`, so a new home's first commit holds
 * `bun.lock`. Everywhere else it prints the command and the person runs it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';

/** The command a person runs to install the home at `folder`. */
export const installNext = (folder: string) => `cd ${folder} && bun install`;

/**
 * The one command that brings the home at `folder` up to date: install every
 * app's packages and Epicenter, then run every app's own build.
 */
export const installAndBuildNext = (folder: string) =>
	`cd ${folder} && bun install && bun run build`;

/** Why `bun install` failed, and the command that tries it again. */
export type InstallProblem = { message: string; next: string };

/**
 * Run `bun install` in `folder`, the top of a home, with the Bun that runs
 * this command. Answers what went wrong, or undefined when it installed.
 */
export async function installHome(
	folder: string,
): Promise<InstallProblem | undefined> {
	const next = installNext(folder);
	if (!existsSync(join(folder, 'package.json')))
		return {
			message: `${folder} has no package.json. A home is a Bun workspace: its package.json lists "workspaces": ["apps/*/code"] and depends on @epicenter/cli and @epicenter/app. Write it, then install.`,
			next,
		};
	try {
		const child = Bun.spawn([process.execPath, 'install'], {
			cwd: folder,
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
				`bun install exited with code ${code}`,
			next,
		};
	} catch (cause) {
		return { message: extractErrorMessage(cause), next };
	}
}
