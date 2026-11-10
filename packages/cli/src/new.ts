/**
 * `epicenter new` and `epicenter link`: the two ways a folder becomes one of
 * your apps in `~/Epicenter` without installing code from a source.
 *
 * - `new <name>` makes the folder from the built-in template, makes it a
 *   repository, and commits the template.
 * - `link <folder> [<name>]` links a folder that already has an
 *   `epicenter.json` into `~/Epicenter`, wherever it lives and whatever it
 *   is: a repository, a folder inside one, or neither. It commits nothing
 *   and moves nothing, so the folder's path, scripts, and remotes keep
 *   working (ADR-0852).
 *
 * The app's name is its entry in `~/Epicenter`: the folder's own name unless
 * a second word gives another. `install` (install.ts) is the third way, for
 * code that comes from a source kept apart from the data.
 */
import { mkdir, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { nameProblem, SCHEMA_URL } from '@epicenter/app';
import { CliError } from './errors.ts';
import { checkedGit } from './git.ts';
import { homeDir, readDeclaration, resolveFolder } from './home.ts';
import { fail, made } from './output.ts';

/** Binary types the template routes through Git LFS (ADR-0856). */
const LFS_TYPES = [
	'webm',
	'm4a',
	'wav',
	'mp3',
	'png',
	'jpg',
	'jpeg',
	'heic',
	'gif',
	'webp',
	'mp4',
	'mov',
	'pdf',
];

/** The built-in template: a declaration, what Git ignores, and what goes through LFS. */
function template(name: string) {
	return {
		'epicenter.json': `${JSON.stringify(
			{ $schema: SCHEMA_URL, description: `Describe ${name}` },
			null,
			2,
		)}\n`,
		'.gitignore': 'node_modules/\n.cache/\n*.local\n*.local.*\n',
		'.gitattributes': LFS_TYPES.map(
			(kind) => `*.${kind} filter=lfs diff=lfs merge=lfs -text\n`,
		).join(''),
	};
}

/** Whether `name` is free in the home, ignoring case, as macOS does. */
export async function taken(name: string) {
	try {
		return (await readdir(homeDir())).some(
			(entry) => entry.toLowerCase() === name.toLowerCase(),
		);
	} catch {
		return false;
	}
}

function done(name: string, json: boolean) {
	return made(
		{ name, folder: join(homeDir(), name), next: `epicenter ${name}` },
		json,
	);
}

/**
 * `epicenter new <name>`: an app from the built-in template, in its own
 * repository whose first commit is the template. It does not set up Git LFS;
 * that is each computer's, once (`git lfs install`).
 */
export async function newCommand(name: string, json: boolean): Promise<number> {
	const problem = nameProblem(name);
	if (problem !== undefined)
		return fail(
			CliError.Usage({ message: `${problem}, so it cannot name an app` }).error,
			json,
		);
	if (await taken(name))
		return fail(
			CliError.Usage({ message: `${name} already exists in ${homeDir()}` })
				.error,
			json,
		);
	try {
		await makeApp(name);
	} catch (error) {
		return fail(CliError.GitFailed({ cause: error }).error, json);
	}
	return done(name, json);
}

/**
 * Make `~/Epicenter/<name>` from the built-in template, in its own repository
 * whose first commit is the template, and return its path. The caller has
 * checked the name. Throws Git's message when Git fails.
 */
export async function makeApp(name: string): Promise<string> {
	const folder = join(homeDir(), name);
	await mkdir(folder, { recursive: true });
	for (const [path, text] of Object.entries(template(name)))
		await writeFile(join(folder, path), text);
	await checkedGit(folder, ['init', '-q']);
	await checkedGit(folder, ['add', '-A']);
	await checkedGit(folder, ['commit', '-q', '-m', `new ${name}`]);
	return folder;
}

/** `epicenter link <folder> [<name>]`. */
export async function linkCommand(
	source: string,
	name: string | undefined,
	json: boolean,
): Promise<number> {
	let folder: string;
	try {
		folder = await realpath(resolveFolder(source));
	} catch {
		return fail(
			CliError.Usage({ message: `${source} is not a folder` }).error,
			json,
		);
	}
	const chosen = name ?? basename(folder);
	const problem = nameProblem(chosen);
	if (problem !== undefined)
		return fail(
			CliError.Usage({
				message: `${problem}, so it cannot name an app. Name it: epicenter link ${source} <name>`,
			}).error,
			json,
		);
	if (await taken(chosen))
		return fail(
			CliError.Usage({ message: `${chosen} already exists in ${homeDir()}` })
				.error,
			json,
		);
	const read = await readDeclaration(folder);
	if ('problems' in read)
		return fail(
			CliError.AppProblems({ app: folder, problems: read.problems }).error,
			json,
		);
	await mkdir(homeDir(), { recursive: true });
	await symlink(folder, join(homeDir(), chosen));
	return done(chosen, json);
}
