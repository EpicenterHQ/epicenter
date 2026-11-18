/** Create an app container from blank code or a committed code copy. */
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
	ActionError,
	type Answer,
	Err,
	type NotStarted,
	Ok,
	type Result,
} from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { nameProblem, parseWords } from './commands.ts';
import { checkedGit, git } from './git.ts';
import { installAndBuildNext } from './install.ts';
import { writeErr } from './output.ts';
import { appsDir, epicenterDir, folderPath } from './root.ts';

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

async function locateSource(from: string): Promise<Result<Source, NotStarted>> {
	const usage = (message: string) =>
		ActionError.NotStarted({
			cause: 'usage',
			message,
			next: 'epicenter new --help',
		});
	if (LOCAL.test(from)) {
		const located = await git(folderPath(from), [
			'rev-parse',
			'--show-toplevel',
			'--show-prefix',
		]);
		if (located.code !== 0)
			return ActionError.NotStarted({
				cause: 'usage',
				message: `${from} is not in a Git repository; --from copies committed code. Put the source in Git and commit it, or put its code in apps/<name>/code/ and run bun install at the top of the home`,
			});
		const [repository = '', prefix = ''] = located.stdout.split('\n');
		return Ok({ kind: 'local', repository, folder: prefix.replace(/\/$/, '') });
	}
	const matched = GITHUB.exec(from);
	if (!matched || matched[2] === '.' || matched[2] === '..') {
		const url = /^[a-z][a-z0-9+.-]*:/i.test(from) || /^[\w.-]+@/.test(from);
		return usage(
			url
				? `--from takes a folder on disk or owner/repo/folder on GitHub; clone ${from} with git clone, then pass the app's folder as a path`
				: `--from ${from} is neither a path nor owner/repo/folder; write a folder on disk as ./${from}`,
		);
	}
	const [, owner = '', repo = '', path = '', ref] = matched;
	const segments = path
		.split('/')
		.filter((segment) => segment !== '' && segment !== '.');
	if (segments.includes('..'))
		return usage(
			`${JSON.stringify(path.slice(1))} is not a folder inside ${owner}/${repo}; write it from the repository's root, without ..`,
		);
	if (ref === '') return usage(`--from ${from} names no ref after #`);
	return Ok({
		kind: 'github',
		repository: `https://github.com/${owner}/${repo}.git`,
		address: `${owner}/${repo}`,
		folder: segments.join('/'),
		...(ref === undefined ? {} : { ref }),
	});
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

/**
 * `epicenter new <name> [--from <path> | --from <owner/repo/folder>[#<ref>]]`:
 * `apps/<name>/code` from blank code or from one committed app folder, beside
 * an empty `data/`. The folder is the answer; the next command goes to stderr.
 * A copy that fails removes the container it made and answers `NotStarted`;
 * blank code that fails to write throws, since the container may be partly made.
 */
export async function newCommand(
	words: string[],
	json: boolean,
): Promise<Answer> {
	const { data: given, error: misused } = parseWords(
		'new',
		words,
		{ from: { type: 'string' } },
		[1, 1],
	);
	if (misused) return Err(misused);
	const [name = ''] = given.positionals;
	const { from } = given.values;
	if (from === '')
		return ActionError.NotStarted({
			cause: 'usage',
			message: '--from needs a folder on disk or owner/repo/folder on GitHub',
			next: 'epicenter new --help',
		});
	const problem = nameProblem(name);
	if (problem !== undefined)
		return ActionError.NotStarted({
			cause: 'usage',
			message: `${problem}, so it cannot name an app`,
		});
	if (await taken(name))
		return ActionError.NotStarted({
			cause: 'usage',
			message: `${name} already exists in ${appsDir()}`,
		});
	const container = join(appsDir(), name);
	const code = join(container, 'code');
	let copied: { commit: string } | undefined;
	if (from === undefined) {
		await mkdir(code, { recursive: true });
		for (const [path, text] of Object.entries(blank(name)))
			await writeFile(join(code, path), text);
	} else {
		const { data: source, error: unlocated } = await locateSource(from);
		if (unlocated) return Err(unlocated);
		await mkdir(container, { recursive: true });
		const { data, error } = await copyApp(from, source, container);
		if (error) {
			await rm(container, { recursive: true, force: true });
			return Err(error);
		}
		copied = data;
	}
	await mkdir(join(container, 'data'));
	if (json)
		return Ok({
			name,
			folder: container,
			...(copied ? { source: copied } : {}),
		});
	// The next step is a hint beside the answer, as stderr carries it today.
	writeErr(`Run: ${installAndBuildNext(epicenterDir())}`);
	return Ok(container);
}

/**
 * Clone the source into `clone` without checking anything out, at the commit
 * to copy. A GitHub clone is shallow and fetches file contents only when they
 * are checked out; a full commit is fetched by itself, since a clone can only
 * start from a branch or tag.
 */
async function cloneSource(source: Source, clone: string) {
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
	if (!commit || source.ref === undefined) return;
	await checkedGit(clone, ['fetch', '-q', '--depth=1', 'origin', source.ref]);
	await checkedGit(clone, ['update-ref', '--no-deref', 'HEAD', 'FETCH_HEAD']);
}

/** The app's folder in the commit: `folder` itself, else its `code/`, by where `epicenter.ts` is. */
async function appFolder(clone: string, folder: string) {
	const inFolder = (path: string) => (folder ? `${folder}/${path}` : path);
	const tracked = (
		await checkedGit(clone, [
			'ls-tree',
			'-z',
			'--name-only',
			'HEAD',
			'--',
			inFolder('epicenter.ts'),
			inFolder('code/epicenter.ts'),
		])
	).split('\0');
	if (tracked.includes(inFolder('epicenter.ts'))) return folder;
	if (tracked.includes(inFolder('code/epicenter.ts'))) return inFolder('code');
	return undefined;
}

/**
 * Check out the app's folder alone and move it to `container/code`. Git keeps
 * modes, links and LFS as it is configured to; `SOURCE.md` records where the
 * code came from. A failure is `NotStarted`: the caller removes the container.
 */
async function copyApp(
	from: string,
	source: Source,
	container: string,
): Promise<Result<{ commit: string }, NotStarted>> {
	const usage = (message: string) =>
		ActionError.NotStarted({ cause: 'usage', message });
	try {
		const clone = join(container, '.clone');
		await cloneSource(source, clone);
		const commit = await checkedGit(clone, ['rev-parse', 'HEAD']);
		const folder = await appFolder(clone, source.folder);
		if (folder === undefined)
			return usage(
				`${from} has no epicenter.ts that Git tracks; name the app's folder`,
			);
		// A local copy is of a commit, so the code there must be that commit.
		// Only the code counts: the app's uncommitted records do not stop a copy.
		if (
			source.kind === 'local' &&
			(await checkedGit(source.repository, [
				'status',
				'--porcelain',
				'--untracked-files=all',
				'--',
				folder || '.',
			]))
		)
			return usage(`${from} has uncommitted changes; commit them, then copy.`);
		// Cone mode reads each line as a folder name, with no pattern characters.
		if (folder) {
			const sparse = await git(clone, ['sparse-checkout', 'set', '--stdin'], {
				input: `${folder}\n`,
			});
			if (sparse.code !== 0) throw new Error(sparse.stderr);
		}
		await checkedGit(clone, ['checkout', '-q']);
		const code = join(container, 'code');
		await rename(join(clone, folder), code);
		await rm(join(code, '.git'), { recursive: true, force: true });
		await rm(clone, { recursive: true, force: true });

		const refused = await nameThePackage(code, basename(container));
		if (refused) return usage(`${from} has a package.json that ${refused}`);
		await writeFile(
			join(code, 'SOURCE.md'),
			[
				"This app's code was copied by `epicenter new --from`. No command reads this file.",
				'',
				`Repository: ${await recordedRepository(source)}`,
				`Folder: ${folder || '.'}`,
				...(source.kind === 'github' && source.ref !== undefined
					? [`Ref: ${source.ref}`]
					: []),
				`Commit: ${commit}`,
				'',
			].join('\n'),
		);
		return Ok({ commit });
	} catch (cause) {
		return ActionError.NotStarted({
			cause: 'internal',
			message: `Git failed: ${extractErrorMessage(cause)}`,
		});
	}
}

/**
 * Two packages in one workspace cannot share a name, so the copy's
 * `package.json` takes the app's. A linked one is refused: writing it would
 * write the file it points to.
 */
async function nameThePackage(code: string, name: string) {
	const file = join(code, 'package.json');
	const entry = await lstat(file).catch(() => undefined);
	if (!entry) return undefined;
	if (entry.isSymbolicLink())
		return `is a link to ${await readlink(file)}; commit the file itself in its place, then copy.`;
	const text = await readFile(file, 'utf8');
	let manifest: unknown;
	try {
		manifest = JSON.parse(text);
	} catch (cause) {
		return `is not JSON: ${extractErrorMessage(cause)}`;
	}
	if (
		typeof manifest !== 'object' ||
		manifest === null ||
		Array.isArray(manifest)
	)
		return 'is not a JSON object';
	// Written with the indent it was read with, so the copy differs only by its name.
	const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? 2;
	await writeFile(
		file,
		`${JSON.stringify({ ...manifest, name }, null, indent)}\n`,
	);
	return undefined;
}
