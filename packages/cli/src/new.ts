/** Create an app container from blank code or a committed code copy. */
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { checkoutCodeFiles, readCodeFiles } from './code-copy.ts';
import { misuse, nameProblem, parseWords } from './commands.ts';
import { CliError } from './errors.ts';
import { checkedGit, git } from './git.ts';
import { installAndBuildNext } from './install.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { appsDir, epicenterDir, folderPath } from './root.ts';

type CopiedSource = { commit: string };

/**
 * Where `--from` takes an app's code. Git moves code between computers; `new`
 * copies one committed folder into this Epicenter.
 *
 * - A folder on disk, written as a path (`/`, `./`, `../`, or `~/`): Git
 *   says which repository holds it, and its current commit is copied. Clone
 *   any other host's repository first.
 * - A folder on GitHub, written `owner/repo[/folder][#ref]`: that one folder
 *   is fetched at the branch, tag, or full commit after `#`, or at the
 *   default branch.
 */
type Source =
	| { kind: 'local'; repository: string; folder: string }
	| {
			kind: 'github';
			repository: string;
			address: string;
			folder: string;
			ref?: string;
	  };

const LOCAL = /^(?:\.{1,2}|~)?(?:\/|$)/;
const GITHUB =
	/^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)(\/[^#]*)?(?:#(.*))?$/;
const COMMIT = /^[0-9a-f]{40}$/i;

async function locateSource(
	from: string,
): Promise<Source | { error: CliError }> {
	if (LOCAL.test(from)) {
		const located = await git(folderPath(from), [
			'rev-parse',
			'--show-toplevel',
			'--show-prefix',
		]);
		if (located.code !== 0)
			return {
				error: CliError.Usage({
					message: `${from} is not in a Git repository; --from copies committed code. Put the source in Git and commit it, or put its code in apps/<name>/code/ and run bun install at the top of the home`,
				}).error,
			};
		const [repository = '', prefix = ''] = located.stdout.split('\n');
		return { kind: 'local', repository, folder: prefix.replace(/\/$/, '') };
	}
	const matched = GITHUB.exec(from);
	if (!matched || matched[2] === '.' || matched[2] === '..') {
		const url = /^[a-z][a-z0-9+.-]*:/i.test(from) || /^[\w.-]+@/.test(from);
		return {
			error: misuse(
				'new',
				url
					? `--from takes a folder on disk or owner/repo/folder on GitHub; clone ${from} with git clone, then pass the app's folder as a path`
					: `--from ${from} is neither a path nor owner/repo/folder; write a folder on disk as ./${from}`,
			),
		};
	}
	const [, owner = '', repo = '', path = '', ref] = matched;
	const segments = path
		.split('/')
		.filter((segment) => segment !== '' && segment !== '.');
	if (segments.includes('..'))
		return {
			error: misuse(
				'new',
				`${JSON.stringify(path.slice(1))} is not a folder inside ${owner}/${repo}; write it from the repository's root, without ..`,
			),
		};
	if (ref === '')
		return { error: misuse('new', `--from ${from} names no ref after #`) };
	return {
		kind: 'github',
		repository: `https://github.com/${owner}/${repo}.git`,
		address: `${owner}/${repo}`,
		folder: segments.join('/'),
		...(ref === undefined ? {} : { ref }),
	};
}

/** How to name one app's folder in the same place `--from` named. */
function suggestedFrom(from: string, source: Source, app: string) {
	if (source.kind === 'local') return join(folderPath(from), app);
	const folder = source.folder ? `${source.folder}/${app}` : app;
	return `${source.address}/${folder}${source.ref === undefined ? '' : `#${source.ref}`}`;
}

/** Provenance: a GitHub address, or a checkout's origin with credentials stripped, else its path. */
async function recordedRepository(source: Source) {
	if (source.kind === 'github') return `https://github.com/${source.address}`;
	const origin = await git(source.repository, ['remote', 'get-url', 'origin']);
	return origin.code === 0 && origin.stdout
		? origin.stdout.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
		: source.repository;
}

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

/** The folder is the answer; the next command goes to stderr. */
async function made(name: string, json: boolean, source?: CopiedSource) {
	const folder = join(appsDir(), name);
	if (json)
		writeJson({
			name,
			folder,
			...(source ? { source } : {}),
		});
	else {
		writeOut(folder);
		writeErr(`Run: ${installAndBuildNext(epicenterDir())}`);
	}
	return 0;
}

/**
 * `epicenter new <name> [--from <path> | --from <owner/repo/folder>[#<ref>]]`: an
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
		return made(name, json);
	}
	const source = await locateSource(from);
	if ('error' in source) return fail(source.error, json);
	const folder = join(appsDir(), name);
	await mkdir(folder);
	const copied = await copySource(from, source, name, join(folder, 'code'));
	if ('error' in copied) {
		await rm(folder, { recursive: true, force: true });
		return fail(copied.error, json);
	}
	let refusal: string | undefined;
	try {
		refusal = await joinWorkspace(join(folder, 'code'), name);
	} catch (cause) {
		refusal = `is not a JSON object: ${extractErrorMessage(cause)}`;
	}
	if (refusal !== undefined) {
		await rm(folder, { recursive: true, force: true });
		return fail(
			CliError.Usage({ message: `${from} has a package.json that ${refusal}` })
				.error,
			json,
		);
	}
	return made(name, json, copied);
}

/**
 * Put the source's commit at a temporary clone's HEAD without checking out
 * files. A local repository is cloned at its current commit. A GitHub folder
 * is fetched shallow and without file contents, which Git fetches later only
 * for the files copied; a full commit is fetched by itself, since a clone can
 * only start from a branch or tag.
 */
async function fetchSource(source: Source, clone: string) {
	if (source.kind === 'local') {
		await checkedGit(tmpdir(), [
			'clone',
			'-q',
			'--no-checkout',
			source.repository,
			clone,
		]);
		return;
	}
	const commit = source.ref !== undefined && COMMIT.test(source.ref);
	await checkedGit(tmpdir(), [
		'clone',
		'-q',
		'--depth=1',
		'--filter=blob:none',
		'--no-checkout',
		...(source.ref !== undefined && !commit ? ['--branch', source.ref] : []),
		source.repository,
		clone,
	]);
	if (!commit) return;
	await checkedGit(clone, ['fetch', '-q', '--depth=1', 'origin', source.ref!]);
	await checkedGit(clone, ['update-ref', '--no-deref', 'HEAD', 'FETCH_HEAD']);
}

/** The apps directly inside `folder`: each child holding `epicenter.ts` or `code/epicenter.ts`. */
async function appsIn(clone: string, folder: string) {
	const listed = await checkedGit(clone, [
		'ls-tree',
		'-r',
		'-z',
		'--name-only',
		'HEAD',
		...(folder ? ['--', folder] : []),
	]);
	const offset = folder ? folder.length + 1 : 0;
	const apps = new Set<string>();
	for (const path of listed.split('\0')) {
		const match = /^([^/]+)\/(?:code\/)?epicenter\.ts$/.exec(
			path.slice(offset),
		);
		if (match?.[1]) apps.add(match[1]);
	}
	return [...apps].sort();
}

/** Copy a filtered committed tree from a temporary clone, preserving Git modes and links. */
async function copySource(
	from: string,
	source: Source,
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
			await fetchSource(source, clone);
			const commit = await checkedGit(clone, ['rev-parse', 'HEAD']);
			// Read trees, not file contents: a GitHub copy fetches only the files it keeps.
			const tracks = async (path: string) =>
				(await checkedGit(clone, [
					'ls-tree',
					'--name-only',
					'HEAD',
					'--',
					inFolder(path),
				])) !== '';
			if (
				!(await tracks('epicenter.ts')) &&
				(await tracks('code/epicenter.ts'))
			)
				source.folder = inFolder('code');
			if (!(await tracks('epicenter.ts'))) {
				const apps = await appsIn(clone, source.folder);
				return usage(
					apps.length
						? `${from} holds ${apps.length === 1 ? 'one app' : `${apps.length} apps`}: ${apps.join(', ')}. Run: epicenter new ${name} --from ${suggestedFrom(from, source, apps[0]!)}`
						: `${from} has no epicenter.ts that Git tracks; name the app's folder`,
				);
			}
			// `new` copies a commit, so the local code it copies must be that
			// commit: Git's own answer, the same one export asks. Only the code
			// counts, so a container's uncommitted records do not stop a copy.
			if (
				source.kind === 'local' &&
				(await checkedGit(source.repository, [
					'status',
					'--porcelain',
					'--untracked-files=all',
					'--',
					source.folder || '.',
				]))
			)
				return usage(
					`${from} has uncommitted changes; commit them, then copy.`,
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
				[
					"This app's code was copied by `epicenter new --from`. No command reads this file.",
					'',
					`Repository: ${await recordedRepository(source)}`,
					`Folder: ${source.folder || '.'}`,
					...(source.kind === 'github' && source.ref !== undefined
						? [`Ref: ${source.ref}`]
						: []),
					`Commit: ${commit}`,
					'',
				].join('\n'),
			);
			return { commit };
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

/**
 * Make copied code a package of this home's workspace. Its `package.json` is
 * named for the app, since two packages in one workspace cannot share a name;
 * it lists no `@epicenter/app`, which the home supplies as one copy; and its
 * own `bun.lock` goes, since the home has one lock. Code with no
 * `package.json` gets the one blank code has. A linked `package.json` is
 * refused, since rewriting it would rewrite the file it points to. Answers
 * why the copy is refused, or undefined when it joined.
 */
async function joinWorkspace(
	code: string,
	name: string,
): Promise<string | undefined> {
	const file = join(code, 'package.json');
	const entry = await lstat(file).catch(() => undefined);
	if (entry?.isSymbolicLink())
		return `is a link to ${await readlink(file)}; commit the file itself in its place, then copy.`;
	// `rm` removes a linked lock, not the file it points to.
	for (const lock of ['bun.lock', 'bun.lockb'])
		await rm(join(code, lock), { force: true });
	const text = await readFile(file, 'utf8').catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return undefined;
			throw error;
		},
	);
	if (text === undefined) {
		await writeFile(file, blank(name)['package.json']);
		return undefined;
	}
	const manifest: unknown = JSON.parse(text);
	if (
		typeof manifest !== 'object' ||
		manifest === null ||
		Array.isArray(manifest)
	)
		throw new Error('it is not an object');
	const fields = manifest as Record<string, unknown>;
	for (const key of [
		'dependencies',
		'devDependencies',
		'peerDependencies',
		'optionalDependencies',
	]) {
		const listed = fields[key];
		if (typeof listed !== 'object' || listed === null) continue;
		delete (listed as Record<string, unknown>)['@epicenter/app'];
		if (Object.keys(listed).length === 0) delete fields[key];
	}
	// Written with the indent it was read with, so the copy differs only where it must.
	const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? 2;
	await writeFile(
		file,
		`${JSON.stringify({ ...fields, name }, null, indent)}\n`,
	);
	return undefined;
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
