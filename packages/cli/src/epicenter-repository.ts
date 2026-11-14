/**
 * The Epicenter's own repository (ADR-0884, ADR-0885). The folder that holds
 * the apps is a repository too, so what lives beside them, `EPICENTER.md`,
 * `AGENTS.md`, and any folder that is not an app, has history and a backup
 * like an app's records. The apps live in `apps/`, each app's code and its
 * data a repository of its own, and the `.gitignore` leaves `apps/` out
 * with one fixed line, as an app's leaves out `data/`. `repositories.json`
 * lists every repository in `apps/` with its origin, so a clone of this
 * repository says which others to clone (`restoreEpicenter`, run by
 * `init --from`).
 *
 * ```txt
 * ~/Epicenter/              this repository
 *   EPICENTER.md AGENTS.md  tracked
 *   notes/                  tracked: a folder that is not a repository
 *   repositories.json       { "apps/vocab": "<origin>", "apps/vocab/data": "<origin>" }
 *   .gitignore              apps/, *.local, node_modules/
 *   apps/vocab/             a repository of its own, listed
 * ```
 */
import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { isRepositoryTop } from './data.ts';
import { checkedGit, git, gitMessage } from './git.ts';
import { installApp } from './install.ts';
import { APPS, MARKER } from './root.ts';
import { commitIn, failedWith, type Snapshot } from './snapshot.ts';

/** The list of every repository inside an Epicenter, at its top. */
export const REPOSITORIES = 'repositories.json';

/** What a new Epicenter's repository ignores: the apps, each backed up on its own; what stays on this computer (ADR-0870); and caches. */
const KEPT_OUT = `${APPS}/\n*.local\n*.local.*\nnode_modules/\n.DS_Store\n`;

/** Binaries a new Epicenter's repository keeps in Git LFS (ADR-0856). */
const LFS_ATTRIBUTES = [
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
]
	.map((extension) => `*.${extension} filter=lfs diff=lfs merge=lfs -text\n`)
	.join('');

/**
 * Every repository inside `root`, as a path from it, parents before
 * children: each folder with a `.git`, found without following a link or
 * entering `node_modules` or a `.git`.
 */
export async function repositoriesIn(root: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (folder: string, path: string) => {
		let entries: Dirent[];
		try {
			entries = await readdir(folder, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (
				!entry.isDirectory() ||
				entry.name === '.git' ||
				entry.name === 'node_modules'
			)
				continue;
			const inside = path ? `${path}/${entry.name}` : entry.name;
			const full = join(folder, entry.name);
			if (existsSync(join(full, '.git'))) found.push(inside);
			await walk(full, inside);
		}
	};
	await walk(root, '');
	return found.sort();
}

/**
 * `url` as the list records it: an http(s) URL loses a user and password
 * written into it, since the list is committed and pushed. An SSH URL's user
 * is a login name, not a secret, and stays.
 */
function withoutCredentials(url: string) {
	if (!URL.canParse(url)) return url;
	const parsed = new URL(url);
	if (!/^https?:$/.test(parsed.protocol)) return url;
	if (!parsed.username && !parsed.password) return url;
	parsed.username = '';
	parsed.password = '';
	return parsed.href;
}

/** The repository's `origin`, as the list records it; `null` when it has none. */
async function originUrl(folder: string) {
	const got = await git(folder, ['remote', 'get-url', 'origin']);
	return got.code === 0 && got.stdout ? withoutCredentials(got.stdout) : null;
}

async function writeIfChanged(path: string, text: string) {
	const current = await readFile(path, 'utf8').catch(() => undefined);
	if (current !== text) await writeFile(path, text);
}

/**
 * Write `repositories.json` from the repositories inside `root` now, each
 * with its origin; written only when it changes.
 */
export async function recordRepositories(root: string) {
	const listed: Record<string, string | null> = {};
	for (const path of await repositoriesIn(root))
		listed[path] = await originUrl(join(root, path));
	await writeIfChanged(
		join(root, REPOSITORIES),
		`${JSON.stringify(listed, null, '\t')}\n`,
	);
	return listed;
}

/** The Epicenter's display name, as its commits begin: its folder's basename. */
export const epicenterLabel = (root: string) => basename(root);

/**
 * Snapshot everything pending in the Epicenter's own repository, as
 * `<Epicenter>: <message>` (default `changed outside epicenter`), after
 * recording the repositories in `apps/`. `null` when the Epicenter's folder
 * is not the top of a repository of its own. It refuses while the
 * `.gitignore` does not leave `apps/` out, while a repository sits outside
 * `apps/`, or while one is in the index as a repository, since a clone holds
 * no way to restore it. Never throws.
 */
export async function snapshotEpicenter(
	root: string,
	message?: string,
): Promise<Snapshot | null> {
	if (!(await isRepositoryTop(root))) return null;
	const label = epicenterLabel(root);
	try {
		const ignored = await git(
			root,
			['check-ignore', '--no-index', '-q', `${APPS}/`],
			true,
		);
		if (ignored.code !== 0)
			return {
				failed: {
					message: `${label}/.gitignore does not list ${APPS}/, so a backup of the Epicenter could take the apps`,
					next: `printf '${APPS}/\n' >> ${join(root, '.gitignore')}`,
				},
			};
		const outside = (await repositoriesIn(root)).find(
			(path) => !path.startsWith(`${APPS}/`),
		);
		if (outside !== undefined)
			return {
				failed: {
					message: `${label}: ${outside} is a repository outside ${APPS}/, which the Epicenter's backup cannot hold`,
					next: `mv ${join(root, outside)} ${join(root, APPS)}/`,
				},
			};
		await recordRepositories(root);
		const embedded = (await checkedGit(root, ['ls-files', '-s', '-z']))
			.split('\0')
			.filter((entry) => entry.startsWith('160000 '))
			.map((entry) => entry.slice(entry.indexOf('\t') + 1));
		if (embedded[0] !== undefined)
			return {
				failed: {
					message: `${label} holds ${embedded[0]} as a repository inside it, which a clone cannot restore`,
					next: `git -C ${root} rm --cached -- ${embedded[0]}`,
				},
			};
		return await commitIn(
			{ folder: root, label, trailers: [] },
			`${label}: ${message ?? 'changed outside epicenter'}`,
		);
	} catch (error) {
		return failedWith(error);
	}
}

/**
 * Make `root` the top of a repository of its own when it is not one yet,
 * with the `.gitignore`, `.gitattributes`, and list the Epicenter's
 * repository keeps (the first two only when absent), and commit what `init` wrote as
 * `<Epicenter>: start the Epicenter`. Files already there are left to the
 * next backup.
 */
export async function startEpicenterRepository(root: string, wrote: string[]) {
	if (!(await isRepositoryTop(root))) await checkedGit(root, ['init', '-q']);
	const ignore = join(root, '.gitignore');
	if (!existsSync(ignore)) await writeFile(ignore, KEPT_OUT);
	const attributes = join(root, '.gitattributes');
	// Binaries go through LFS only where it is installed: routed without its
	// filter, every backup would be refused.
	if (!existsSync(attributes) && Bun.which('git-lfs')) {
		await checkedGit(root, ['lfs', 'install', '--local']);
		await writeFile(attributes, LFS_ATTRIBUTES);
	}
	await recordRepositories(root);
	const files = [
		'.gitignore',
		...(existsSync(attributes) ? ['.gitattributes'] : []),
		REPOSITORIES,
		...wrote,
	];
	await checkedGit(root, ['add', '--', ...files]);
	await checkedGit(root, [
		'commit',
		'-q',
		'-m',
		`${epicenterLabel(root)}: start the Epicenter`,
		'--',
		...files,
	]);
}

/** What `restoreEpicenter` did, path by path. */
export type Restored = {
	folder: string;
	/** Repositories cloned from their origins. */
	cloned: string[];
	/** Repositories already there, left as they were. */
	kept: string[];
	/** Repositories the list names with no origin, so there is nothing to clone. */
	unbacked: string[];
	/** Repositories, or apps' packages, that failed, with Git's or the installer's message. */
	failed: { path: string; message: string }[];
};

/** Whether `path`, from the list, names a folder inside the Epicenter and nothing else. */
const isInside = (path: string) =>
	path !== '' &&
	!path.startsWith('/') &&
	!path.includes('\\') &&
	path
		.split('/')
		.every(
			(part) => part !== '' && part !== '.' && part !== '..' && part !== '.git',
		);

/** The list at `root`, every entry checked; throws naming the first that does not fit. */
async function readList(root: string): Promise<Record<string, string | null>> {
	const path = join(root, REPOSITORIES);
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new Error(`${REPOSITORIES} is not an object of paths and origins`);
	for (const [listed, origin] of Object.entries(parsed)) {
		if (!isInside(listed))
			throw new Error(
				`${REPOSITORIES} lists ${JSON.stringify(listed)}, which is not a folder inside the Epicenter`,
			);
		if (origin !== null && typeof origin !== 'string')
			throw new Error(
				`${REPOSITORIES} gives ${listed} the origin ${JSON.stringify(origin)}, which is not a URL or null`,
			);
	}
	return parsed as Record<string, string | null>;
}

/**
 * Rebuild an Epicenter at `folder`, which must be missing or empty, from the
 * Epicenter's repository at `url`: clone it, then clone every repository its
 * list names into its place, parents first, leaving one already there as it
 * is, then install each app's packages. It never overwrites a file. Throws
 * when the clone fails or is not an Epicenter; a repository or an install
 * that fails after that is reported, and the others go on.
 */
export async function restoreEpicenter(
	url: string,
	folder: string,
): Promise<Restored> {
	if (existsSync(folder) && (await readdir(folder)).length > 0)
		throw new Error(`${folder} is not empty; restore into a new folder`);
	await mkdir(dirname(folder), { recursive: true });
	const cloned = await git(dirname(folder), ['clone', '-q', url, folder]);
	if (cloned.code !== 0) throw new Error(gitMessage(['clone'], cloned));
	if (!existsSync(join(folder, MARKER)))
		throw new Error(
			`${url} has no ${MARKER} at its top, so it is not an Epicenter's repository`,
		);
	const restored: Restored = {
		folder,
		cloned: [],
		kept: [],
		unbacked: [],
		failed: [],
	};
	const list = await readList(folder);
	for (const path of Object.keys(list).sort()) {
		const origin = list[path];
		const place = join(folder, path);
		if (existsSync(place)) {
			restored.kept.push(path);
			continue;
		}
		if (origin === null || origin === undefined) {
			restored.unbacked.push(path);
			continue;
		}
		await mkdir(dirname(place), { recursive: true });
		const got = await git(dirname(place), ['clone', '-q', origin, place]);
		if (got.code === 0) restored.cloned.push(path);
		else restored.failed.push({ path, message: gitMessage(['clone'], got) });
	}
	const apps = join(folder, APPS);
	const entries = existsSync(apps)
		? await readdir(apps, { withFileTypes: true })
		: [];
	for (const entry of entries) {
		const app = join(apps, entry.name);
		if (!entry.isDirectory() || !existsSync(join(app, 'epicenter.ts')))
			continue;
		try {
			const installed = await installApp(app, entry.name);
			if ('error' in installed)
				restored.failed.push({
					path: `${APPS}/${entry.name}`,
					message: installed.error.message,
				});
		} catch (error) {
			restored.failed.push({
				path: `${APPS}/${entry.name}`,
				message: extractErrorMessage(error),
			});
		}
	}
	return restored;
}
