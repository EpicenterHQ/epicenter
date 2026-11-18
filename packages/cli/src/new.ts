/**
 * `epicenter new <name>`: a blank app. Taking an existing app is copying its
 * `code/` folder, which the operating system and Git already do (ADR-0955).
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActionError, type Answer, Err, Ok } from '@epicenter/app';
import { nameProblem, parseWords } from './commands.ts';
import { installAndBuildNext } from './install.ts';
import { writeErr } from './output.ts';
import { appsDir, epicenterDir } from './root.ts';

/**
 * Blank app code: one package in the home's workspace, named for the app,
 * whose records live beside code/. It lists no packages: `@epicenter/app`
 * comes from the home.
 */
function blank(name: string) {
	return {
		'.gitignore': 'node_modules/\nui/dist/\n',
		'package.json': `${JSON.stringify({ name, private: true }, null, 2)}\n`,
		'epicenter.ts': `import { defineApp } from '@epicenter/app';

export default defineApp({
	description: 'Describe ${name}',
	actions: {},
});
`,
	};
}

/** Whether `name` is taken in apps/, ignoring case, as macOS does. */
async function taken(name: string) {
	try {
		return (await readdir(appsDir())).some(
			(entry) => entry.toLowerCase() === name.toLowerCase(),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * Make `apps/<name>/code` from blank code beside an empty `data/`. The folder
 * is the answer; the next command goes to stderr.
 */
export async function newCommand(
	words: string[],
	json: boolean,
): Promise<Answer> {
	const { data: given, error: misused } = parseWords('new', words, {}, [1, 1]);
	if (misused) return Err(misused);
	const [name = ''] = given.positionals;
	const problem = nameProblem(name);
	if (problem !== undefined)
		return ActionError.NotStarted({
			cause: 'usage',
			message: `${problem}, so it cannot name an app`,
		});
	if (await taken(name))
		return ActionError.NotStarted({
			cause: 'usage',
			message: `${name} already exists in ${appsDir()}`,
		});
	const folder = join(appsDir(), name);
	const code = join(folder, 'code');
	await mkdir(code, { recursive: true });
	await mkdir(join(folder, 'data'));
	for (const [path, text] of Object.entries(blank(name)))
		await writeFile(join(code, path), text);
	if (json) return Ok({ name, folder });
	// The next step is a hint beside the answer, as stderr carries it today.
	writeErr(`Run: ${installAndBuildNext(epicenterDir())}`);
	return Ok(folder);
}
