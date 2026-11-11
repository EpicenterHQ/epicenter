/**
 * `epicenter new` makes an app in the selected Epicenter: two repositories,
 * the app's folder for its code and `data/` for its data (ADR-0877).
 *
 * - `new <name> --from <git url|path>` clones a starter, another app's code,
 *   keeps it as the app's `upstream` remote with the branch tracking nothing,
 *   makes an empty data repository, and builds its UI (ADR-0866). `epicenter
 *   update` later merges the starter's changes.
 * - `new <name>` makes the folder from the built-in template, makes it a
 *   repository, commits the template, and makes the data repository.
 * The app's name is its child entry in the Epicenter.
 */
import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { misuse, nameProblem, parseWords } from './commands.ts';
import { dataRepository } from './data.ts';
import { CliError } from './errors.ts';
import { checkedGit, git } from './git.ts';
import { loadHomeApp } from './home.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { epicenterDir, folderPath } from './root.ts';
import { buildUi } from './ui.ts';

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

/** Whether `name` is taken in the Epicenter, ignoring case, as macOS does. */
async function taken(name: string) {
	try {
		return (await readdir(epicenterDir())).some(
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
 * object. An app made whose UI did not build is still made, so it exits 1,
 * not 2, naming `epicenter build <name>`.
 */
function made(
	name: string,
	json: boolean,
	error?: { message: string; next: string },
) {
	const folder = join(epicenterDir(), name);
	if (json) writeJson({ name, folder, ...(error ? { error } : {}) });
	else {
		writeOut(folder);
		writeErr(
			error ? `${error.message}\nRun: ${error.next}` : `Run: epicenter ${name}`,
		);
		// A new app has no origin: a starter's remote is its upstream (ADR-0851).
		writeErr(
			`not backed up\nRun: git -C ${folder} remote add origin <url> and git -C ${folder}/data remote add origin <url>, each a private repository, then epicenter sync ${name}`,
		);
	}
	return error ? 1 : 0;
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
			CliError.Usage({ message: `${name} already exists in ${epicenterDir()}` })
				.error,
			json,
		);
	if (from === undefined) {
		try {
			await makeApp(name);
		} catch (error) {
			return fail(CliError.GitFailed({ cause: error }).error, json);
		}
		return made(name, json);
	}
	const folder = join(epicenterDir(), name);
	const cloned = await cloneStarter(from, folder);
	if ('error' in cloned) {
		await rm(folder, { recursive: true, force: true });
		return fail(cloned.error, json);
	}
	try {
		await buildUi(name, folder);
	} catch (error) {
		return made(name, json, {
			message: `${name}: the UI did not build: ${extractErrorMessage(error)}`,
			next: `epicenter build ${name}`,
		});
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
): Promise<{ ok: true } | { error: CliError }> {
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
		await mkdir(epicenterDir(), { recursive: true });
		await checkedGit(tmpdir(), ['clone', '-q', source, folder]);
		await checkedGit(folder, ['remote', 'rename', 'origin', 'upstream']);
		await checkedGit(folder, ['branch', '--unset-upstream']);
		await dataRepository(basename(folder), folder, { make: true });
	} catch (error) {
		return { error: CliError.GitFailed({ cause: error }).error };
	}
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
 * Make `<Epicenter>/<name>` from the built-in template, in its own repository
 * whose first commit is the template. The caller has checked the name.
 * Throws Git's message when Git fails.
 */
async function makeApp(name: string) {
	const folder = join(epicenterDir(), name);
	await mkdir(folder, { recursive: true });
	for (const [path, text] of Object.entries(template(name)))
		await writeFile(join(folder, path), text);
	await checkedGit(folder, ['init', '-q']);
	await checkedGit(folder, ['add', '-A']);
	await checkedGit(folder, ['commit', '-q', '-m', `new ${name}`]);
	await dataRepository(name, folder, { make: true });
}
