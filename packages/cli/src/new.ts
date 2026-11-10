/**
 * `epicenter new` and `epicenter link`: the ways a folder becomes one of your
 * apps in `~/Epicenter`.
 *
 * - `new <name> --from <git url|path>` clones a starter, a repository with no
 *   data, keeps it as the app's `upstream` remote with the branch tracking
 *   nothing, and builds its UI (ADR-0866). `epicenter update` later merges
 *   the starter's changes.
 * - `new <name>` makes the folder from the built-in template, makes it a
 *   repository, and commits the template.
 * - `link <folder> [<name>]` links a folder that already has an
 *   `epicenter.json` into `~/Epicenter`, wherever it lives and whatever it
 *   is: a repository, a folder inside one, or neither. It commits nothing
 *   and moves nothing, so the folder's path, scripts, and remotes keep
 *   working (ADR-0852).
 *
 * The app's name is its entry in `~/Epicenter`: for `link`, the folder's own
 * name unless a second word gives another.
 */
import {
	mkdir,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { nameProblem, SCHEMA_URL } from '@epicenter/app';
import { CliError } from './errors.ts';
import { checkedGit, git } from './git.ts';
import { homeDir, readDeclaration, resolveFolder } from './home.ts';
import { fail, made, presentAnswer } from './output.ts';
import { buildUi } from './ui.ts';

/** A Git URL rather than a folder path: a scheme, or `user@host:path`. */
function isUrl(source: string) {
	return (
		/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[\w.-]+@[\w.-]+:/.test(source)
	);
}

/**
 * The built-in template: a declaration and what Git ignores. It routes
 * nothing through Git LFS; an app that comes to hold binary files adds its
 * own `.gitattributes` (ADR-0856).
 */
function template(name: string) {
	return {
		'epicenter.json': `${JSON.stringify(
			{ $schema: SCHEMA_URL, description: `Describe ${name}` },
			null,
			2,
		)}\n`,
		'.gitignore': 'node_modules/\n.cache/\n*.local\n*.local.*\n',
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
 * `epicenter new <name> [--from <git url|path>]`: an app from a starter kept
 * as its `upstream`, or from the built-in template.
 */
export async function newCommand(
	name: string,
	from: string | undefined,
	json: boolean,
): Promise<number> {
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
	if (from === undefined) {
		try {
			await makeApp(name);
		} catch (error) {
			return fail(CliError.GitFailed({ cause: error }).error, json);
		}
		return done(name, json);
	}
	const folder = join(homeDir(), name);
	const cloned = await cloneStarter(from, folder);
	if ('error' in cloned) {
		await rm(folder, { recursive: true, force: true });
		return fail(cloned.error, json);
	}
	try {
		await buildUi(folder);
	} catch (error) {
		// The app is made and only its UI is missing, so this exits 1, not 2:
		// update builds it again.
		presentAnswer(
			{ error: CliError.BuildFailed({ app: name, cause: error }).error },
			json,
		);
		return 1;
	}
	return done(name, json);
}

/**
 * Clone the starter `from` into `folder`, rename its remote to `upstream`,
 * and leave the branch tracking nothing, so no push ever reaches the starter.
 * A path must be a repository's root, since Git clones only whole
 * repositories; the clone must hold a valid `epicenter.json`.
 */
async function cloneStarter(
	from: string,
	folder: string,
): Promise<{ ok: true } | { error: CliError }> {
	let source = from;
	if (!isUrl(from)) {
		source = resolveFolder(from);
		const top = await git(source, ['rev-parse', '--show-toplevel']);
		if (
			top.code !== 0 ||
			(await realpath(top.stdout)) !== (await realpath(source))
		)
			return {
				error: CliError.Usage({
					message: `${from} is not a repository's root; a starter is a repository of its own`,
				}).error,
			};
	}
	try {
		await mkdir(homeDir(), { recursive: true });
		await checkedGit(tmpdir(), ['clone', '-q', source, folder]);
		await checkedGit(folder, ['remote', 'rename', 'origin', 'upstream']);
		await checkedGit(folder, ['branch', '--unset-upstream']);
	} catch (error) {
		return { error: CliError.GitFailed({ cause: error }).error };
	}
	const read = await readDeclaration(folder);
	if ('problems' in read)
		return {
			error: CliError.AppProblems({ app: from, problems: read.problems }).error,
		};
	return { ok: true };
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
