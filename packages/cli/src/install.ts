/**
 * Install an app's packages from its lock at the app's top, then link the
 * command's own @epicenter/app (ADR-0880). Calls never install packages.
 * Installation runs outside the app's lock, including after new and update.
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { COMPILED } from './child.ts';
import { misuse, parseWords } from './commands.ts';
import { chooseApps } from './home.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { linkAppPackage } from './app-package.ts';

/** Install the locked packages, when present, and link the command's app package. */
export async function installApp(
	folder: string,
	app = basename(folder),
): Promise<
	{ installed: boolean } | { error: { message: string; next?: string } }
> {
	const next = `cd ${folder} && bun install && epicenter install ${app}`;
	try {
		const frozen = existsSync(join(folder, 'bun.lock'));
		const installed = existsSync(join(folder, 'package.json'));
		if (installed) {
			const child = Bun.spawn(
				[process.execPath, 'install', ...(frozen ? ['--frozen-lockfile'] : [])],
				{
					cwd: folder,
					env: { ...process.env, ...(COMPILED ? { BUN_BE_BUN: '1' } : {}) },
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (code !== 0)
				return {
					error: {
						message:
							stderr.trim() ||
							stdout.trim() ||
							`bun install exited with code ${code}`,
						next,
					},
				};
		}
		await linkAppPackage(folder);
		return { installed };
	} catch (cause) {
		return { error: { message: extractErrorMessage(cause), next } };
	}
}

/** Install each app, or the named app, without loading its actions. */
export async function installCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, {}, [0, 1]);
	if (!given) return fail(misuse('install'), json);
	const { data: chosen, error } = await chooseApps(given.positionals[0]);
	if (error) return fail(error, json);
	const apps = [];
	for (const { entry: app, realPath: folder } of chosen) {
		const result = await installApp(folder, app);
		const row = {
			app,
			folder,
			installed: 'installed' in result ? result.installed : false,
			...('error' in result ? { error: result.error } : {}),
		};
		apps.push(row);
		if (json) continue;
		if (row.error) {
			writeErr(`${app}: ${row.error.message}`);
			if (row.error.next) writeErr(`Run: ${row.error.next}`);
		} else
			writeOut(`${app}: ${row.installed ? 'installed packages and linked @epicenter/app' : 'linked @epicenter/app'}`);
	}
	if (json) writeJson({ apps });
	return apps.some((app) => app.error) ? 1 : 0;
}
