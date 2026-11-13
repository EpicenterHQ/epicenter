/**
 * `epicenter new` makes an app in the selected Epicenter: two repositories,
 * the app's folder for its code and `data/` for its data (ADR-0877).
 *
 * - `new <name> --from <git url|path>` clones a starter, another app's code,
 *   keeps it as the app's `upstream` remote with the branch tracking nothing,
 *   and makes an empty data repository (ADR-0866); `serve` builds its UI
 *   when it is first opened. `epicenter update` later merges the starter's
 *   changes.
 * - `new <name>` makes the folder from the built-in template, makes it a
 *   repository, commits the template, and makes the data repository.
 * Both install the app's locked packages and link @epicenter/app before
 * loading epicenter.ts. An install failure keeps the app for repair.
 * The app's name is its child entry in the Epicenter.
 */
import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
		'.gitignore': 'data/\nnode_modules/\n',
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
		// A new app has no origin: a starter's remote is its upstream (ADR-0851).
		writeErr(
			`not backed up\nRun: git -C ${folder} remote add origin <url> and git -C ${folder}/data remote add origin <url>, each a private repository, then epicenter sync ${name}`,
		);
	}
	return 0;
}

/**
 * `epicenter new <name> [--from <git url|path>]`: an app from a starter kept
 * as its `upstream`, or from the built-in template.
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
	const folder = join(appsDir(), name);
	const cloned = await cloneStarter(from, folder);
	if ('installError' in cloned)
		return installFailed(name, cloned.installError, json);
	if ('error' in cloned) {
		await rm(folder, { recursive: true, force: true });
		return fail(cloned.error, json);
	}
	return made(name, json);
}

/**
 * Clone the starter `from` into `folder`, rename its remote to `upstream`,
 * and leave the branch tracking nothing, so no push ever reaches the starter.
 * A path must be a repository's root, since Git clones only whole
 * repositories; the clone must hold an `epicenter.ts` that loads.
 */
async function cloneStarter(
	from: string,
	folder: string,
): Promise<
	| { ok: true }
	| { error: CliError }
	| { installError: { message: string; next?: string } }
> {
	let source = from;
	if (!isUrl(from)) {
		source = folderPath(from);
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
		await mkdir(appsDir(), { recursive: true });
		await checkedGit(tmpdir(), ['clone', '-q', source, folder]);
		await checkedGit(folder, ['remote', 'rename', 'origin', 'upstream']);
		await checkedGit(folder, ['branch', '--unset-upstream']);
		await dataRepository(basename(folder), folder, { make: true });
	} catch (error) {
		return { error: CliError.GitFailed({ cause: error }).error };
	}
	const installed = await installApp(folder);
	if ('error' in installed) return { installError: installed.error };
	const { data: located, error } = await loadHomeApp(basename(folder));
	if (error) return { error };
	if (!located.ok)
		return {
			error: CliError.AppProblems({ app: from, problems: located.problems })
				.error,
		};
	return { ok: true };
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
