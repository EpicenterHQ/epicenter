/**
 * `epicenter install`: one `bun install` at the top of the home. A home is
 * one Bun workspace whose `package.json` depends on `@epicenter/cli` and
 * `@epicenter/app` and takes each `apps/<app>/code` as a package, so one
 * install, one `bun.lock` and one `node_modules/` serve the command and every
 * app. A call never installs.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { misuse, parseWords } from './commands.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { epicenterDir } from './root.ts';

/** Why `bun install` failed, and the command that tries it again. */
export type InstallProblem = { message: string; next: string };

/**
 * Run `bun install` in `folder`, the top of a home, with the Bun that runs
 * this command. Answers what went wrong, or undefined when it installed.
 */
export async function installHome(
	folder: string,
): Promise<InstallProblem | undefined> {
	const next = `cd ${folder} && bun install`;
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

/** Install the home's packages without loading any app. */
export async function installCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	if (!parseWords(words, {}, [0, 0])) return fail(misuse('install'), json);
	const folder = epicenterDir();
	const error = await installHome(folder);
	if (json)
		writeJson({ folder, installed: !error, ...(error ? { error } : {}) });
	else if (error) {
		writeErr(error.message);
		writeErr(`Run: ${error.next}`);
	} else writeOut(`Installed the packages of ${folder}`);
	return error ? 1 : 0;
}
