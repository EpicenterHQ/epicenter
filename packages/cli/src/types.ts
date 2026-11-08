/**
 * `epicenter types`: write `epicenter.d.json.ts` beside an app's
 * `epicenter.json`, so TypeScript reads the import with its literal types
 * (ADR-0857). Only this command and `epicenter new` write it; loading an app
 * never does, and the listing notes when it is missing or stale.
 */
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { problemsOf } from '@epicenter/app';
import { CliError } from './errors.ts';
import {
	homeDir,
	isFolderPath,
	resolveFolder,
	writeDeclarationTypes,
} from './home.ts';
import { fail, writeJson, writeOut } from './output.ts';

/** Write the types for the app named `target` in the home, or for the folder at `target`. */
export async function typesCommand(
	target: string,
	json: boolean,
): Promise<number> {
	const failure = (message: string) =>
		fail(CliError.Usage({ message }).error, json);
	let folder: string;
	let declaration: unknown;
	try {
		folder = await realpath(
			isFolderPath(target) ? resolveFolder(target) : join(homeDir(), target),
		);
		declaration = JSON.parse(
			await readFile(join(folder, 'epicenter.json'), 'utf8'),
		);
	} catch (error) {
		return failure(
			`${target} has no readable epicenter.json: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const problems = problemsOf(declaration);
	if (problems.length) return failure(problems.join('\n'));
	const path = await writeDeclarationTypes(folder, declaration);
	if (json) writeJson({ path });
	else writeOut(path);
	return 0;
}
