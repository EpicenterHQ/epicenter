/** Build one app's UI or every app's UI, preserving each last good build. */
import { extractErrorMessage } from 'wellcrafted/error';
import { CliError } from './errors.ts';
import { homeEntries } from './home.ts';
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
	if (words.length > 1)
		return fail(
			CliError.Usage({ message: 'epicenter build takes at most one app' })
				.error,
			json,
		);
	const [name] = words;
	const entries = await homeEntries();
	const chosen =
		name === undefined
			? entries
			: entries.filter((entry) => entry.entry === name);
	if (name !== undefined && chosen.length === 0)
		return fail(
			CliError.Usage({ message: `Unknown app "${name}"`, next: 'epicenter' })
				.error,
			json,
		);
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
