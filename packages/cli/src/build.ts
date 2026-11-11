/**
 * `epicenter build [<app>]`: build each view from its code's `HEAD` now and
 * show the build's errors. `serve` rebuilds on its own when `HEAD` moves; this
 * is for seeing a build through, or its failure, without waiting.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { misuse, parseWords } from './commands.ts';
import { chooseApps } from './home.ts';
import { fail, writeJson } from './output.ts';
import { buildView } from './ui.ts';

type Built = {
	app: string;
	folder: string;
	/** The commit the view was built from, or `null` when there was nothing to build. */
	built: string | null;
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
		const result: Built = { app: entry, folder: realPath, built: null };
		try {
			result.built = (await buildView(entry, realPath)) ?? null;
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
					`${app.app}: ${app.built ? `view built from ${app.built.slice(0, 7)}` : 'nothing to build'}\n`,
				);
		}
	return apps.some((app) => app.error) ? 1 : 0;
}
