/**
 * `epicenter new` makes an app in the selected Epicenter: two repositories,
 * the app's folder for its code and `data/` for its data (ADR-0877).
 *
 * - `new <name> --from <path>` and `new <name> --from <git url>[#<folder>]`
 *   take another app's code by copying it (ADR-0904): the files Git tracks
 *   in the app's folder, at the commit its repository's `HEAD` names. The
 *   copy is a repository of its own whose one commit names the source and
 *   that commit. It has no remote and none of the source's history, and no
 *   data comes with it. From then on the code is changed where it is: taking
 *   the source's later changes is work for an agent that reads the source,
 *   not a merge any command performs. `serve` builds its UI when it is first
 *   opened.
 * - `new <name>` makes the folder from the built-in template, makes it a
 *   repository, commits the template, and makes the data repository.
 * Both install the app's locked packages and link @epicenter/app before
 * loading epicenter.ts. An install failure keeps the app for repair.
 * The app's name is its child entry in the Epicenter.
 */
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { misuse, nameProblem, parseWords } from './commands.ts';
import { dataRepository } from './data.ts';
import { ENGINES } from './engines.ts';
import { CliError } from './errors.ts';
import { checkedGit, git } from './git.ts';
import { loadHomeApp } from './home.ts';
import { installApp } from './install.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { appsDir, folderPath } from './root.ts';

/** A Git URL rather than a folder path: a scheme, or `user@host:path`. */
function isUrl(source: string) {
	return (
		/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[\w.-]+@[\w.-]+:/.test(source)
	);
}

/**
 * Where `--from` takes an app's code: the repository to clone, and the folder
 * inside it that holds the app, empty for the repository's root.
 *
 * - A Git URL names a repository, and after its first `#`, a folder inside
 *   it, so a URL cannot contain `#` and a folder's name can. The folder is
 *   read from the repository's root: `.` segments and extra slashes are
 *   dropped, and an absolute path or a `..` is a misuse.
 * - Anything else is a path to the app's folder itself, whole: a `#` in it is
 *   part of the path. Git says which repository holds the folder and where,
 *   so it may be a repository's root or any folder inside one. It must be
 *   inside a repository, since only what Git tracks is copied.
 */
async function locateSource(
	from: string,
): Promise<{ repository: string; folder: string } | { error: CliError }> {
	if (!isUrl(from)) {
		const located = await git(folderPath(from), [
			'rev-parse',
			'--show-toplevel',
			'--show-prefix',
		]);
		if (located.code !== 0)
			return {
				error: CliError.Usage({
					message: `${from} is not in a Git repository; --from takes only the files Git tracks`,
				}).error,
			};
		const [repository = '', prefix = ''] = located.stdout.split('\n');
		return { repository, folder: prefix.replace(/\/$/, '') };
	}
	const at = from.indexOf('#');
	if (at === -1) return { repository: from, folder: '' };
	const given = from.slice(at + 1);
	const segments = given
		.split('/')
		.filter((segment) => segment !== '' && segment !== '.');
	if (given.startsWith('/') || segments.includes('..'))
		return {
			error: misuse(
				'new',
				`${JSON.stringify(given)} is not a folder inside the repository; write its path from the repository's root, without ..`,
			),
		};
	if (segments.length === 0)
		return {
			error: misuse('new', `--from ${from} names no folder after #`),
		};
	return { repository: from.slice(0, at), folder: segments.join('/') };
}

/**
 * `from` as the app's first commit records it. A path is made absolute, so it
 * still names a place when read from another folder. An http(s) URL loses any
 * credentials it carries, since the commit is pushed with the app.
 */
function recordedSource(from: string) {
	return isUrl(from)
		? from.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
		: folderPath(from);
}

/** What every app's code ignores: its data, a repository of its own, and its installed packages. */
const IGNORED = ['data/', 'node_modules/'];

/**
 * The built-in template: an app with no collections or actions yet, and what
 * its code's Git ignores, starting with its data, a repository of its own. It
 * routes nothing through Git LFS; an app that comes to hold binary files adds
 * its own `.gitattributes` (ADR-0856).
 */
function template(name: string) {
	return {
		'package.json': `${JSON.stringify({ name, private: true, engines: ENGINES }, null, 2)}\n`,
		'epicenter.ts': `import { defineApp } from '@epicenter/app';

export default defineApp({
	description: 'Describe ${name}',
	collections: {},
	actions: {},
});
`,
		'.gitignore': IGNORED.map((line) => `${line}\n`).join(''),
	};
}

/** Whether `name` is taken in `apps/`, ignoring case, as macOS does. */
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
 * Say what `new` made: the folder on stdout and the next step on stderr, then
 * that it is not backed up and how to back it up, or with `--json`, one
 * object.
 */
function made(name: string, json: boolean) {
	const folder = join(appsDir(), name);
	if (json) writeJson({ name, folder });
	else {
		writeOut(folder);
		writeErr(`Run: epicenter ${name}`);
		// A new app has no remote, whether from the template or from another app's code (ADR-0851).
		writeErr(
			`not backed up\nRun: git -C ${folder} remote add origin <url> and git -C ${folder}/data remote add origin <url>, each a private repository, then epicenter sync ${name}`,
		);
	}
	return 0;
}

/**
 * `epicenter new <name> [--from <path> | --from <git url>[#<folder>]]`: an
 * app from a copy of another app's code, or from the built-in template.
 */
export async function newCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, { from: { type: 'string' } }, [1, 1]);
	if (!given || given.values.from === '') return fail(misuse('new'), json);
	const [name = ''] = given.positionals;
	const { from } = given.values;
	const problem = nameProblem(name);
	if (problem !== undefined)
		return fail(
			CliError.Usage({ message: `${problem}, so it cannot name an app` }).error,
			json,
		);
	if (await taken(name))
		return fail(
			CliError.Usage({ message: `${name} already exists in ${appsDir()}` })
				.error,
			json,
		);
	if (from === undefined) {
		try {
			await makeApp(name);
		} catch (error) {
			return fail(CliError.GitFailed({ cause: error }).error, json);
		}
		const installed = await installApp(join(appsDir(), name), name);
		if ('error' in installed) return installFailed(name, installed.error, json);
		return made(name, json);
	}
	const source = await locateSource(from);
	if ('error' in source) return fail(source.error, json);
	const folder = join(appsDir(), name);
	const copied = await copySource(from, source, name, folder);
	if ('installError' in copied)
		return installFailed(name, copied.installError, json);
	if ('error' in copied) {
		await rm(folder, { recursive: true, force: true });
		return fail(copied.error, json);
	}
	return made(name, json);
}

/**
 * Copy the app in `source` into `folder` as the app `name`: a repository of
 * its own whose one commit holds the copy and names, in two trailers, where
 * it came from (`recordedSource`) and the commit copied. Nothing reads the
 * trailers; they are there for the person and their agent.
 *
 * The copy is read from Git, never from the source's folder on disk: Git
 * writes exactly the files the commit tracks in that folder, with their modes
 * and symlinks, so an app's `data/`, `node_modules/`, and builds never come
 * along. It writes them from a shallow clone with nothing checked out. The
 * clone is made in the system's temporary folder, since an Epicenter lists
 * every repository inside it (`epicenter-repository.ts`), and it is removed
 * whatever happens.
 *
 * The folder taken must hold an `epicenter.ts` that loads, and no `data/`: a
 * source carries code alone.
 */
async function copySource(
	from: string,
	source: { repository: string; folder: string },
	name: string,
	folder: string,
): Promise<
	| { ok: true }
	| { error: CliError }
	| { installError: { message: string; next?: string } }
> {
	const usage = (message: string) => ({
		error: CliError.Usage({ message }).error,
	});
	const inFolder = (path: string) =>
		source.folder === '' ? path : `${source.folder}/${path}`;
	try {
		const clone = await mkdtemp(join(tmpdir(), 'epicenter-new-'));
		try {
			await checkedGit(tmpdir(), [
				'clone',
				'-q',
				'--depth=1',
				'--no-checkout',
				source.repository,
				clone,
			]);
			const commit = await checkedGit(clone, ['rev-parse', 'HEAD']);
			const tracks = async (path: string) =>
				(await git(clone, ['cat-file', '-e', `HEAD:${inFolder(path)}`]))
					.code === 0;
			if (!(await tracks('epicenter.ts')))
				return usage(
					`${from} has no epicenter.ts that Git tracks${isUrl(from) && source.folder === '' ? `; name the app's folder with --from ${from}#<folder>` : ''}`,
				);
			if (await tracks('data'))
				return usage(
					`${from} tracks files under data/, and an app's data is never copied`,
				);
			await mkdir(appsDir(), { recursive: true });
			// The clone's index takes the folder's tree alone, and Git writes that index out at the app's folder.
			await checkedGit(clone, ['read-tree', `HEAD:${source.folder}`]);
			await checkedGit(clone, ['checkout-index', '-a', `--prefix=${folder}/`]);
			await ignoreDataAndPackages(folder);
			await checkedGit(folder, ['init', '-q']);
			// Forced, so the commit holds every file copied, whatever the copied .gitignore or this computer's Git ignores.
			await checkedGit(folder, ['add', '-A', '-f']);
			await checkedGit(folder, [
				'commit',
				'-q',
				'-m',
				`new ${name}`,
				'--trailer',
				`Source: ${recordedSource(from)}`,
				'--trailer',
				`Source-Commit: ${commit}`,
			]);
			await dataRepository(name, folder, { make: true });
		} finally {
			await rm(clone, { recursive: true, force: true });
		}
	} catch (error) {
		return { error: CliError.GitFailed({ cause: error }).error };
	}
	const installed = await installApp(folder);
	if ('error' in installed) return { installError: installed.error };
	const { data: located, error } = await loadHomeApp(name);
	if (error) return { error };
	if (!located.ok)
		return {
			error: CliError.AppProblems({ app: from, problems: located.problems })
				.error,
		};
	return { ok: true };
}

/**
 * Make the code at `folder` ignore `data/` and `node_modules/`, adding to its
 * `.gitignore` whichever line is missing. A folder taken from inside a larger
 * repository may have relied on that repository's own `.gitignore`.
 */
async function ignoreDataAndPackages(folder: string) {
	const path = join(folder, '.gitignore');
	let text = '';
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const present = new Set(text.split('\n').map((line) => line.trim()));
	const missing = IGNORED.filter((line) => !present.has(line));
	if (missing.length === 0) return;
	// Removed first, so a .gitignore that is a symlink becomes the app's own file, never a write through the link.
	await rm(path, { force: true });
	await writeFile(
		path,
		`${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.map((line) => `${line}\n`).join('')}`,
	);
}

/**
 * Make `<Epicenter>/apps/<name>` from the built-in template, in its own repository
 * whose first commit is the template. The caller has checked the name.
 * Throws Git's message when Git fails.
 */
async function makeApp(name: string) {
	const folder = join(appsDir(), name);
	await mkdir(folder, { recursive: true });
	for (const [path, text] of Object.entries(template(name)))
		await writeFile(join(folder, path), text);
	await checkedGit(folder, ['init', '-q']);
	await checkedGit(folder, ['add', '-A']);
	await checkedGit(folder, ['commit', '-q', '-m', `new ${name}`]);
	await dataRepository(name, folder, { make: true });
}

/** Keep the app on disk so its packages can be repaired and installed again. */
function installFailed(
	name: string,
	error: { message: string; next?: string },
	json: boolean,
) {
	if (json) writeJson({ name, folder: join(appsDir(), name), error });
	else {
		writeErr(`${name}: ${error.message}`);
		if (error.next) writeErr(`Run: ${error.next}`);
	}
	return 1;
}
