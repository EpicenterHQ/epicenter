/**
 * An app's data repository (ADR-0877). The app's folder is its code
 * repository, which ignores `data/`; `data/` is a repository of its own,
 * holding everything the app keeps (ADR-0876). A record's path is the same
 * everywhere, `data/words/<word>.md`: only Git calls made in the data
 * repository use the path inside it (`words/<word>.md`), and what they find
 * is named from the app's folder again before anyone sees it.
 *
 * `epicenter` makes the data repository the first time it commits to it,
 * or when `new` makes the app, so an app cloned from its code has one before
 * its first record is kept.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedGit, git } from './git.ts';

/** The folder, under an app's, that is its data repository. */
export const DATA = 'data';

/** What a new data repository ignores: what stays on this computer (ADR-0870). */
const DATA_IGNORE = '*.local\n*.local.*\n';

/** The data repository's folder for the app at `app`. */
export function dataFolder(app: string) {
	return join(app, DATA);
}

/** `path`, a path from the app's folder under `data/`, as a path inside the data repository. */
export function inData(path: string) {
	return path.startsWith(`${DATA}/`) ? path.slice(DATA.length + 1) : path;
}

/** `path`, inside the data repository, as a path from the app's folder. */
export function fromData(path: string) {
	return `${DATA}/${path}`;
}

/** The code repository's `HEAD` commit, or `undefined` when the app's folder has no commit of its own. */
export async function codeHead(app: string): Promise<string | undefined> {
	if (!(await isRepositoryTop(app))) return undefined;
	const head = await git(app, ['rev-parse', '-q', '--verify', 'HEAD']);
	return head.code === 0 ? head.stdout : undefined;
}

/** The trailer a data commit carries: the code it was written under, when the code has a commit. */
export async function codeTrailer(app: string) {
	const head = await codeHead(app);
	return head === undefined ? undefined : `Code-Commit: ${head}`;
}

/** The commit a data commit's message names as its code, when it names one. */
export function codeCommitOf(body: string) {
	return /^Code-Commit: ([0-9a-f]{40}|[0-9a-f]{64})$/m.exec(body)?.[1];
}

/** Whether `folder` is the top of a Git repository of its own. */
export async function isRepositoryTop(folder: string) {
	const top = await git(folder, ['rev-parse', '--show-toplevel']);
	if (top.code !== 0) return false;
	const [root, here] = await Promise.all([
		realpath(top.stdout).catch(() => ''),
		realpath(folder).catch(() => folder),
	]);
	return root === here;
}

/**
 * The data repository of the app `name` at `app`, made first when `make` and
 * `data/` has no repository yet: Git's `init`, a `.gitignore` of `*.local`
 * files, the app's own `.gitattributes` copied in, so binaries its code
 * routes through LFS go there too (ADR-0856), and one commit of those two
 * files alone, as `<name>: start its data`, so records already there, or a
 * first call's writes, are committed under their own names. `undefined` when there is none and
 * `make` is false. Throws when `data/` is inside a repository but not the top
 * of its own, since a commit there would land in the wrong history.
 */
export async function dataRepository(
	name: string,
	app: string,
	{ make }: { make: boolean },
): Promise<string | undefined> {
	const folder = dataFolder(app);
	if (existsSync(join(folder, '.git'))) {
		if (await isRepositoryTop(folder)) return folder;
		throw new Error(
			`${name}/data has a .git that is not a repository of its own, so nothing was committed to it`,
		);
	}
	if (!make) return undefined;
	await mkdir(folder, { recursive: true });
	await checkedGit(folder, ['init', '-q']);
	const ignore = join(folder, '.gitignore');
	if (!existsSync(ignore)) await writeFile(ignore, DATA_IGNORE);
	const attributes = join(folder, '.gitattributes');
	if (!existsSync(attributes) && existsSync(join(app, '.gitattributes')))
		await copyFile(join(app, '.gitattributes'), attributes);
	await checkedGit(folder, [
		'add',
		'.gitignore',
		...(existsSync(attributes) ? ['.gitattributes'] : []),
	]);
	const trailer = await codeTrailer(app);
	await checkedGit(folder, [
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		`${name}: start its data`,
		...(trailer ? ['--trailer', trailer] : []),
	]);
	return folder;
}
