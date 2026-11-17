/** Create an app container from blank code or a committed code copy. */
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	checkoutCodeFiles,
	isCopiedCodePath,
	readCodeFiles,
} from './code-copy.ts';
import { misuse, nameProblem, parseWords } from './commands.ts';
import { ENGINES } from './engines.ts';
import { CliError } from './errors.ts';
import { checkedGit, git } from './git.ts';
import { loadHomeApp } from './home.ts';
import { installApp } from './install.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { appsDir, epicenterDir, epicenterRoot, folderPath } from './root.ts';
import { uiSource } from './ui.ts';

type CopiedSource = { commit: string; notCopied?: string[] | null };

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
					message: `${from} is not in a Git repository; --from copies committed code. Put the source in Git and commit it, or put its code in apps/<name>/code/ and run epicenter install <name>`,
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

/** Source provenance keeps absolute paths and strips HTTP credentials. */
function recordedSource(from: string) {
	return isUrl(from)
		? from.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
		: folderPath(from);
}

/** Blank app code is one Bun project whose records live beside code/. */
function blank(name: string) {
	return {
		'.gitignore': 'node_modules/\nui/dist/\n',
		'package.json': `${JSON.stringify({ name, private: true, engines: ENGINES }, null, 2)}\n`,
		'epicenter.ts': `import { defineApp } from '@epicenter/app';

export default defineApp({
	description: 'Describe ${name}',
	collections: {},
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

/** The folder is the answer; the next command goes to stderr. */
async function made(name: string, json: boolean, source?: CopiedSource) {
	const folder = join(appsDir(), name);
	const links = await danglingLinks(join(folder, 'code'));
	for (const { path, target } of links)
		writeErr(
			`${name}: code/${path} links to ${target}, which this Epicenter does not have`,
		);
	if (json)
		writeJson({
			name,
			folder,
			...(source ? { source } : {}),
			...(links.length ? { links } : {}),
		});
	else {
		writeOut(folder);
		writeSourceWarning(name, source);
		if (await uiSource(join(folder, 'code'))) {
			const { port } = epicenterRoot();
			writeErr('Run: epicenter serve');
			writeErr(
				port
					? `Open http://127.0.0.1:${port}/${name}/ in your browser.`
					: `Open /${name}/ at the address printed by serve.`,
			);
		} else writeErr(`Run: epicenter ${name}`);
	}
	return 0;
}

/**
 * `epicenter new <name> [--from <path> | --from <git url>[#<folder>]]`: an
 * app from a copy of another app's code, or from blank code.
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
	await mkdir(appsDir(), { recursive: true });
	if (from === undefined) {
		try {
			await makeApp(name);
		} catch (error) {
			return fail(CliError.GitFailed({ cause: error }).error, json);
		}
		const installed = await installApp(join(appsDir(), name, 'code'), name);
		if ('error' in installed) return installFailed(name, installed.error, json);
		return made(name, json);
	}
	const source = await locateSource(from);
	if ('error' in source) return fail(source.error, json);
	const folder = join(appsDir(), name);
	let created = false;
	try {
		await mkdir(folder);
		created = true;
	} catch (cause) {
		return fail(CliError.GitFailed({ cause }).error, json);
	}
	const copied = await copySource(from, source, name, join(folder, 'code'));
	if ('error' in copied) {
		if (created) await rm(folder, { recursive: true, force: true });
		return fail(copied.error, json);
	}
	const installed = await installApp(join(folder, 'code'), name);
	if ('error' in installed)
		return installFailed(name, installed.error, json, copied);
	const { data: located, error } = await loadHomeApp(name);
	const loadProblem =
		error ??
		(located.ok
			? undefined
			: CliError.AppProblems({ app: from, problems: located.problems }).error);
	if (loadProblem) {
		await rm(folder, { recursive: true, force: true });
		return fail(loadProblem, json);
	}
	return made(name, json, copied);
}

/** Compare local source with the copied commit, including staged and untracked code. */
async function notCopied(repository: string, folder: string, commit: string) {
	let worktree = repository;
	if (isUrl(repository)) {
		if (!/^file:/i.test(repository)) return undefined;
		try {
			worktree = fileURLToPath(repository);
		} catch {
			return undefined;
		}
	}
	const bare = await git(worktree, ['rev-parse', '--is-bare-repository']);
	if (bare.code !== 0) return null;
	if (bare.stdout === 'true') return undefined;
	const path = folder ? `${folder}/` : '.';
	const compared = await Promise.all([
		git(worktree, [
			'diff',
			'--no-ext-diff',
			'--no-renames',
			'--name-only',
			'-z',
			commit,
			'--',
			path,
		]),
		git(worktree, [
			'diff',
			'--cached',
			'--no-ext-diff',
			'--no-renames',
			'--name-only',
			'-z',
			commit,
			'--',
			path,
		]),
		git(worktree, [
			'ls-files',
			'--others',
			'--exclude-standard',
			'-z',
			'--',
			path,
		]),
	]);
	if (compared.some(({ code }) => code !== 0)) return null;
	const offset = folder ? folder.length + 1 : 0;
	return [
		...new Set(
			compared
				.flatMap(({ stdout }) =>
					stdout
						.split('\0')
						.filter(Boolean)
						.map((path) => path.slice(offset)),
				)
				.filter(isCopiedCodePath),
		),
	].sort();
}

function writeSourceWarning(name: string, source?: CopiedSource) {
	if (source?.notCopied === null)
		writeErr(
			`${name}: copied source commit ${source.commit}; could not compare local source files with it`,
		);
	else if (source?.notCopied?.length) {
		writeErr(
			`${name}: copied source commit ${source.commit}; ${source.notCopied.length} source file(s) differ from it and were not copied`,
		);
		const shown = source.notCopied
			.slice(0, 5)
			.map((path) => JSON.stringify(path))
			.join(', ');
		writeErr(`Not copied: ${shown}${source.notCopied.length > 5 ? ', …' : ''}`);
	}
}

/** Copy a filtered committed tree from a temporary clone, preserving Git modes and links. */
async function copySource(
	from: string,
	source: { repository: string; folder: string },
	name: string,
	folder: string,
): Promise<CopiedSource | { error: CliError }> {
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
			if (
				!(await tracks('epicenter.ts')) &&
				(await tracks('code/epicenter.ts'))
			)
				source.folder = inFolder('code');
			if (!(await tracks('epicenter.ts')))
				return usage(
					`${from} has no epicenter.ts that Git tracks; name the app's folder with --from ${source.repository}#<folder>`,
				);
			// Keep full paths and ancestor attributes in the index. Select checkout paths
			// separately, so root-owned LFS attributes still apply to a subfolder copy.
			await checkedGit(clone, ['read-tree', 'HEAD']);
			const { entries, selected } = await readCodeFiles(clone, source.folder);
			if (entries.some(({ mode }) => mode === '160000'))
				return usage(
					`${from} contains a gitlink; copy a folder without embedded repositories`,
				);
			let lfs: string[];
			const staging = await mkdtemp(join(appsDir(), name, '.code-build-copy-'));
			try {
				lfs = await checkoutCodeFiles(clone, selected, staging);
				await rename(join(staging, source.folder), folder);
			} finally {
				await rm(staging, { recursive: true, force: true });
			}
			// Attributes inherited from outside the copied folder must travel with its bytes.
			const relativeLfs = lfs.map((path) =>
				source.folder === '' ? path : path.slice(source.folder.length + 1),
			);
			await preserveLfs(folder, name, relativeLfs);

			await mkdir(join(appsDir(), name, 'data'), { recursive: true });
			await writeFile(
				join(folder, 'SOURCE.md'),
				`This app's code was copied by \`epicenter new --from\`. No command reads this file.\n\nSource: ${recordedSource(from)}\nSource-Commit: ${commit}\n`,
			);
			return {
				commit,
				notCopied: await notCopied(source.repository, source.folder, commit),
			};
		} finally {
			await rm(clone, { recursive: true, force: true });
		}
	} catch (error) {
		return { error: CliError.GitFailed({ cause: error }).error };
	}
}

/** Add only LFS rules lost when the source folder was detached from its ancestors. */
async function preserveLfs(folder: string, name: string, paths: string[]) {
	if (!paths.length) return;
	const checked = await git(
		epicenterDir(),
		['check-attr', '-z', '--stdin', 'filter'],
		{
			input: `${paths.map((path) => `apps/${name}/code/${path}`).join('\0')}\0`,
		},
	);
	if (checked.code !== 0) throw new Error(checked.stderr);
	const fields = checked.stdout.split('\0');
	const needed = paths.filter((_, i) => fields[i * 3 + 2] !== 'lfs');
	if (!needed.length) return;
	const file = join(folder, '.gitattributes');
	const existing = await readFile(file, 'utf8').catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return '';
			throw error;
		},
	);
	// Replace a copied symlink instead of writing into its target.
	await rm(file, { force: true });
	const rules = needed.map((path) => {
		// Attribute patterns use wildmatch; quote whitespace and escape metacharacters.
		const pattern = `/${path.replace(/[\\*?[\]]/g, '\\$&')}`;
		return `${JSON.stringify(pattern)} filter=lfs diff=lfs merge=lfs -text`;
	});
	await writeFile(
		file,
		`${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${rules.join('\n')}\n`,
	);
}

/** The caller has checked that the container name is free. */
async function makeApp(name: string) {
	const container = join(appsDir(), name);
	await mkdir(container);
	const folder = join(container, 'code');
	await mkdir(folder);
	await mkdir(join(container, 'data'));
	for (const [path, text] of Object.entries(blank(name)))
		await writeFile(join(folder, path), text);
}

/** Keep the app on disk so its packages can be repaired and installed again. */
function installFailed(
	name: string,
	error: { message: string; next?: string },
	json: boolean,
	source?: CopiedSource,
) {
	if (json)
		writeJson({
			name,
			folder: join(appsDir(), name),
			error,
			...(source ? { source } : {}),
		});
	else {
		writeSourceWarning(name, source);
		writeErr(`${name}: ${error.message}`);
		if (error.next) writeErr(`Run: ${error.next}`);
	}
	return 1;
}

/** Report copied links exactly as stored, without following directory links. */
async function danglingLinks(
	folder: string,
	prefix = '',
): Promise<{ path: string; target: string }[]> {
	const links: { path: string; target: string }[] = [];
	for (const entry of await readdir(join(folder, prefix), {
		withFileTypes: true,
	})) {
		if (entry.name === 'node_modules') continue;
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		const full = join(folder, path);
		if (entry.isDirectory()) links.push(...(await danglingLinks(folder, path)));
		else if (
			entry.isSymbolicLink() &&
			!(await realpath(full).catch(() => undefined))
		)
			links.push({ path, target: await readlink(full) });
	}
	return links;
}
