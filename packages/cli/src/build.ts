/** Build one app's UI or every app's UI, preserving each last good build. */
import { extractErrorMessage } from 'wellcrafted/error';
import { misuse, parseWords } from './commands.ts';
import { chooseApps } from './home.ts';
import { fail, writeJson } from './output.ts';
import { buildUi } from './ui.ts';

type Built = {
	app: string;
	folder: string;
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
			result.built = await buildUi(realPath);
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
					`${app.app}: ${app.built ? 'UI built' : 'no ui/'}\n`,
				);
		}
	return apps.some((app) => app.error) ? 1 : 0;
}
