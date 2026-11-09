/**
 * `epicenter add` makes something one of your apps, by linking or cloning
 * (ADR-0852). Neither commits anything:
 *
 * - `add <folder>` links the folder into `~/Epicenter`, whatever it is: a
 *   repository, a folder inside one, or neither.
 * - `add <git url>` is `git clone` into `~/Epicenter`; the clone's remotes
 *   are Git's.
 *
 * The app's name is its entry in `~/Epicenter`: the folder's or repository's
 * own name, as `git clone` picks one, unless a second word gives another.
 *
 * `epicenter new <name>` makes the folder from the built-in template, makes
 * it a repository, and commits the template.
 */
import { randomUUID } from 'node:crypto';
import {
	mkdir,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
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

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Whether `name` is free in the home, ignoring case, as macOS does. */
async function taken(name: string) {
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
	const folder = join(homeDir(), name);
	await mkdir(folder, { recursive: true });
	for (const [path, text] of Object.entries(template(name)))
		await writeFile(join(folder, path), text);
	try {
		await checkedGit(folder, ['init', '-q']);
		await checkedGit(folder, ['add', '-A']);
		await checkedGit(folder, ['commit', '-q', '-m', `new ${name}`]);
	} catch (error) {
		return fail(CliError.GitFailed({ cause: error }).error, json);
	}
	return done(name, json);
}

/** A Git URL rather than a folder path: a scheme, or `user@host:path`. */
function isUrl(source: string) {
	return (
		/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[\w.-]+@[\w.-]+:/.test(source)
	);
}

/** The name `git clone` would give `source`: its last part, without `.git`. */
function nameOf(source: string) {
	return basename(source.replace(/[/\\]+$/, '').replace(/^.*:/, '/')).replace(
		/\.git$/,
		'',
	);
}

/** `epicenter add <folder> [<name>]` or `epicenter add <git url> [<name>]`. */
export async function addCommand(
	source: string,
	name: string | undefined,
	json: boolean,
): Promise<number> {
	const url = isUrl(source);
	let folder: string | undefined;
	if (!url) {
		try {
			folder = await realpath(resolveFolder(source));
		} catch {
			return fail(
				CliError.Usage({ message: `${source} is not a folder` }).error,
				json,
			);
		}
	}
	const chosen = name ?? nameOf(folder ?? source);
	const problem = nameProblem(chosen);
	if (problem !== undefined)
		return fail(
			CliError.Usage({
				message: `${problem}, so it cannot name an app. Name it: epicenter add ${source} <name>`,
			}).error,
			json,
		);
	if (await taken(chosen))
		return fail(
			CliError.Usage({ message: `${chosen} already exists in ${homeDir()}` })
				.error,
			json,
		);
	return folder === undefined
		? addFromUrl(source, chosen, json)
		: addFolder(folder, chosen, json);
}

async function addFolder(folder: string, name: string, json: boolean) {
	const read = await readDeclaration(folder);
	if ('problems' in read)
		return fail(
			CliError.AppProblems({ app: folder, problems: read.problems }).error,
			json,
		);
	await mkdir(homeDir(), { recursive: true });
	await symlink(folder, join(homeDir(), name));
	return done(name, json);
}

async function addFromUrl(url: string, name: string, json: boolean) {
	await mkdir(homeDir(), { recursive: true });
	// Clone beside the apps under a hidden name, which discovery skips, then move it into place.
	const staging = join(homeDir(), `.adding-${randomUUID()}`);
	try {
		await checkedGit(homeDir(), ['clone', '-q', url, staging]);
		const read = await readDeclaration(staging);
		if ('problems' in read)
			return fail(
				CliError.AppProblems({ app: url, problems: read.problems }).error,
				json,
			);
		await rename(staging, join(homeDir(), name));
		return done(name, json);
	} catch (error) {
		return fail(CliError.GitFailed({ cause: error }).error, json);
	} finally {
		if (await exists(staging))
			await rm(staging, { recursive: true, force: true });
	}
}
