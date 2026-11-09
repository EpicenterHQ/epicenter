/**
 * `epicenter add` makes something one of your apps (ADR-0852):
 *
 * - From a folder, it links the folder into `~/Epicenter` under its declared
 *   name. A folder that is not yet a Git repository is refused unless
 *   `--init` asks to make one, committing what is there.
 * - From a Git URL, it copies the app into a new repository in
 *   `~/Epicenter`, keeping the source as the `upstream` remote and branch,
 *   which record where it came from and at which commit. The copy's own
 *   branch tracks nothing until you give it an `origin`.
 *
 * `epicenter new <name>` is `add` from the built-in template.
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
import { join } from 'node:path';
import { nameProblem, SCHEMA_URL } from '@epicenter/app';
import { CliError } from './errors.ts';
import { checkedGit, git } from './git.ts';
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
			{ $schema: SCHEMA_URL, name, description: `Describe ${name}` },
			null,
			2,
		)}\n`,
		'.gitignore': 'node_modules/\n.cache/\n',
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

/**
 * Make `folder` an app's repository the way every app is made, for `new`,
 * `add --init`, and `add <url>` alike: write the template's files it lacks,
 * make it a repository if it is not one, set up Git LFS's filter when
 * `git-lfs` is installed, and only then stage and commit, so the ignore rules
 * and LFS apply to the first thing committed. Commits nothing when nothing
 * changed.
 */
async function adopt(folder: string, name: string, subject: string) {
	for (const [path, text] of Object.entries(template(name)))
		if (!(await exists(join(folder, path))))
			await writeFile(join(folder, path), text);
	if (!(await isRepositoryTop(folder)))
		await checkedGit(folder, ['init', '-q']);
	if (Bun.which('git-lfs'))
		await checkedGit(folder, ['lfs', 'install', '--local']);
	await checkedGit(folder, ['add', '-A']);
	if ((await git(folder, ['diff', '--cached', '--quiet'])).code !== 0)
		await checkedGit(folder, ['commit', '-q', '--no-verify', '-m', subject]);
}

/** Whether `folder` is the top of its own Git repository. */
async function isRepositoryTop(folder: string) {
	const top = await git(folder, ['rev-parse', '--show-toplevel']);
	return (
		top.code === 0 && (await realpath(top.stdout.toString().trim())) === folder
	);
}

function done(name: string, json: boolean) {
	return made(
		{ name, folder: join(homeDir(), name), next: `epicenter ${name}` },
		json,
	);
}

/** `epicenter new <name>`: an app from the built-in template, in its own repository with one commit. */
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
	try {
		await adopt(folder, name, `new ${name}`);
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

/** `epicenter add <folder> [--init]` or `epicenter add <git url>`. */
export async function addCommand(
	source: string,
	init: boolean,
	json: boolean,
): Promise<number> {
	return isUrl(source)
		? addFromUrl(source, json)
		: addFolder(source, init, json);
}

async function addFolder(source: string, init: boolean, json: boolean) {
	let folder: string;
	try {
		folder = await realpath(resolveFolder(source));
	} catch {
		return fail(
			CliError.Usage({ message: `${source} is not a folder` }).error,
			json,
		);
	}
	const read = await readDeclaration(folder);
	if ('problems' in read)
		return fail(
			CliError.AppProblems({ app: folder, problems: read.problems }).error,
			json,
		);
	const { name } = read.declaration;
	if (await taken(name))
		return fail(
			CliError.Usage({ message: `${name} already exists in ${homeDir()}` })
				.error,
			json,
		);
	if (!(await isRepositoryTop(folder))) {
		if (!init)
			return fail(
				CliError.Usage({
					message: `${folder} is not a Git repository yet; --init makes one and commits what is there`,
					next: `epicenter add ${source} --init`,
				}).error,
				json,
			);
		try {
			await adopt(folder, name, `add ${name}`);
		} catch (error) {
			return fail(CliError.GitFailed({ cause: error }).error, json);
		}
	}
	await mkdir(homeDir(), { recursive: true });
	await symlink(folder, join(homeDir(), name));
	return done(name, json);
}

async function addFromUrl(url: string, json: boolean) {
	await mkdir(homeDir(), { recursive: true });
	// Clone beside the apps under a hidden name, which discovery skips, then move it into place.
	const staging = join(homeDir(), `.adding-${randomUUID()}`);
	try {
		await checkedGit(homeDir(), [
			'clone',
			'-q',
			'--origin',
			'upstream',
			url,
			staging,
		]);
		const read = await readDeclaration(staging);
		if ('problems' in read)
			return fail(
				CliError.AppProblems({ app: url, problems: read.problems }).error,
				json,
			);
		const { name } = read.declaration;
		if (await taken(name))
			return fail(
				CliError.Usage({ message: `${name} already exists in ${homeDir()}` })
					.error,
				json,
			);
		const branch = await checkedGit(staging, [
			'rev-parse',
			'--abbrev-ref',
			'HEAD',
		]);
		await checkedGit(staging, [
			'branch',
			'--track',
			'upstream',
			`upstream/${branch}`,
		]);
		// The copy is yours: its branch pushes nowhere until it has an origin.
		await checkedGit(staging, ['branch', '--unset-upstream', branch]);
		await adopt(staging, name, `add ${name}`);
		await rename(staging, join(homeDir(), name));
		return done(name, json);
	} catch (error) {
		return fail(CliError.GitFailed({ cause: error }).error, json);
	} finally {
		if (await exists(staging))
			await rm(staging, { recursive: true, force: true });
	}
}
