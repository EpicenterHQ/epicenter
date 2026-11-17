/**
 * The `bun install` that `init` and `new` run at the top of the home. A home
 * is one Bun workspace whose `package.json` depends on `@epicenter/cli` and
 * `@epicenter/app` and takes each `apps/<app>/code` as a package, so one
 * install, one `bun.lock` and one `node_modules/` serve the command and every
 * app. Epicenter has no install command: the person runs `bun install` at the
 * top of the home. A call never installs.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';

/** The command a person runs to install the home at `folder`. */
export const installNext = (folder: string) => `cd ${folder} && bun install`;

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
