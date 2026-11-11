/**
 * `epicenter build [<app>]`: build each app's UI from its sources now and show
 * the build's errors. `serve` rebuilds on its own when a page loads after the
 * sources changed; this is for seeing a build through, or its failure,
 * without waiting.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { misuse, parseWords } from './commands.ts';
import { chooseApps } from './home.ts';
import { fail, writeJson } from './output.ts';
import { buildUi } from './ui.ts';

type Built = {
	app: string;
	folder: string;
	/** Whether there was a UI to build. */
	built: boolean;
	error?: { message: string };
};

export async function buildCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, {}, [0, 1]);
	if (!given) return fail(misuse('build'), json);
	const { data: chosen, error } = await chooseApps(given.positionals[0]);
	if (error) return fail(error, json);
	const apps: Built[] = [];
	for (const { entry, realPath } of chosen) {
		const result: Built = { app: entry, folder: realPath, built: false };
		try {
			result.built = await buildUi(entry, realPath);
		} catch (error) {
			result.error = { message: extractErrorMessage(error) };
		}
		apps.push(result);
	}
	if (json) writeJson({ apps });
	else
		for (const app of apps) {
			if (app.error) process.stderr.write(`${app.app}: ${app.error.message}\n`);
			else
				process.stdout.write(
					`${app.app}: ${app.built ? 'UI built' : 'nothing to build'}\n`,
				);
		}
	return apps.some((app) => app.error) ? 1 : 0;
}
