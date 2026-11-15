/** Export committed app code into replaceable directories, leaving publication to Git. */
import { createHash } from 'node:crypto';
import {
	chmod,
	copyFile,
	lstat,
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
import {
	basename,
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
} from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import {
	checkoutCodeFiles,
	EXPORT_MARKER,
	isCopiedCodePath,
	readCodeFiles,
} from './code-copy.js';
import { misuse, nameProblem, parseWords } from './commands.js';
import { CliError } from './errors.js';
import { checkedGit, git } from './git.js';
import { homeEntries } from './home.js';
import { hold } from './lock.js';
import { fail, writeErr, writeJson, writeOut } from './output.js';
import { epicenterDir, folderPath } from './root.js';

type ExportMarker = { app: string; digest: string };
type ExportReport = {
	app: string;
	directory: string;
	status: 'created' | 'updated' | 'unchanged' | 'refused' | 'failed' | 'stale';
	materialized?: { path: string; from: string }[];
	uncommitted?: boolean;
	problem?: string;
};

function refuse(message: string): never {
	throw CliError.Refused({ message }).error;
}

function isRefused(cause: unknown) {
	return (
		typeof cause === 'object' &&
		cause !== null &&
		'name' in cause &&
		cause.name === 'Refused'
	);
}

async function info(path: string) {
	return lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	});
}

/** Resolve existing ancestors too, so aliases such as /tmp cannot bypass the boundary. */
async function canonical(path: string): Promise<string> {
	if (await info(path)) return realpath(path);
	return join(await canonical(dirname(path)), basename(path));
}

function contains(parent: string, child: string) {
	const path = relative(parent, child);
	return (
		path === '' ||
		(!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
	);
}

async function checkLocation(directory: string, source: string) {
	if ((await info(directory))?.isSymbolicLink())
		refuse(`${directory} is a symbolic link; choose a real export directory`);
	const resolved = await canonical(directory);
	if (contains(source, resolved) || contains(resolved, source))
		refuse(
			`${directory} overlaps this Epicenter; export to a separate directory`,
		);
	if (resolved.split(sep).some((part) => part.toLowerCase() === '.git'))
		refuse(`${directory} is inside Git's own files`);
	return resolved;
}

/** A crashed swap may have left the only copy of a publication repository here. */
async function checkInterrupted(parent: string) {
	const work = (await readdir(parent)).filter((name) =>
		name.startsWith('.epicenter-export-'),
	);
	if (work.length)
		refuse(
			`Unfinished export directories need inspection before refreshing: ${work.map((name) => join(parent, name)).join(', ')}. A previous export or its Git files may be inside; recover them before removing these directories`,
		);
}

/** Hash output bytes and modes without following links or reading the destination's Git. */
async function digest(folder: string) {
	const hash = createHash('sha256');
	async function walk(prefix: string) {
		const names = (await readdir(join(folder, prefix))).sort();
		for (const name of names) {
			if (name === '.DS_Store') continue;
			if (!prefix && (name === '.git' || name === EXPORT_MARKER)) continue;
			const path = prefix ? `${prefix}/${name}` : name;
			const full = join(folder, path);
			const entry = await lstat(full);
			if (entry.isDirectory()) {
				hash.update(`${JSON.stringify([path, 'directory'])}\n`);
				await walk(path);
			} else if (entry.isSymbolicLink()) {
				hash.update(
					`${JSON.stringify([path, 'link', await readlink(full)])}\n`,
				);
			} else if (entry.isFile()) {
				const bytes = await readFile(full);
				hash.update(
					`${JSON.stringify([path, 'file', Boolean(entry.mode & 0o111), bytes.length])}\n`,
				);
				hash.update(bytes);
			} else
				refuse(`${full} is not a regular file, directory, or symbolic link`);
		}
	}
	await walk('');
	return `sha256:${hash.digest('hex')}`;
}

async function readMarker(
	directory: string,
): Promise<ExportMarker | undefined> {
	const path = join(directory, EXPORT_MARKER);
	const entry = await info(path);
	if (!entry) return undefined;
	if (!entry.isFile()) refuse(`${path} must be a regular export marker`);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		refuse(`${path} is not a valid export marker`);
	}
	if (
		typeof value !== 'object' ||
		value === null ||
		Object.keys(value).length !== 2 ||
		!('app' in value) ||
		typeof value.app !== 'string' ||
		!('digest' in value) ||
		typeof value.digest !== 'string' ||
		!/^sha256:[0-9a-f]{64}$/.test(value.digest)
	)
		refuse(`${path} is not a valid export marker`);
	return { app: value.app, digest: value.digest };
}

async function destination(directory: string, app: string) {
	const entry = await info(directory);
	if (!entry) return undefined;
	if (!entry.isDirectory()) refuse(`${directory} is not a real directory`);
	const gitEntry = await info(join(directory, '.git'));
	if (gitEntry && !gitEntry.isDirectory() && !gitEntry.isFile())
		refuse(`${directory}/.git must be a directory or a regular file`);
	const marker = await readMarker(directory);
	if (!marker) {
		if (
			(await readdir(directory)).some(
				(name) => name !== '.git' && name !== '.DS_Store',
			)
		)
			refuse(`${directory} is not empty and was not created by export`);
		return undefined;
	}
	if (marker.app !== app)
		refuse(`${directory} is an export of ${marker.app}, not ${app}`);
	if ((await digest(directory)) !== marker.digest)
		refuse(
			`${directory} has changed since its last export; move those edits into the live app before refreshing`,
		);
	return marker;
}

/**
 * Keep internal links when their targets travel with the app. A relative
 * link to a committed shared file outside apps/ is copied by value instead;
 * private records and another app's files never enter through a link.
 */
async function materializeLinks(
	repository: string,
	commit: string,
	entries: { path: string; mode: string }[],
	tree: string,
	prefix: string,
	lfsStorage: string,
) {
	const materialized: { path: string; from: string }[] = [];
	for (const entry of entries.filter(({ mode }) => mode === '120000')) {
		const file = join(tree, entry.path);
		const target = await readlink(file);
		const path = entry.path.slice(prefix.length + 1);
		const resolved = posix.normalize(
			posix.join(posix.dirname(entry.path), target),
		);
		if (
			posix.isAbsolute(target) ||
			resolved === '..' ||
			resolved.startsWith('../')
		)
			refuse(`${path} links outside this Epicenter: ${target}`);
		if (resolved === prefix || resolved.startsWith(`${prefix}/`)) continue;
		if (
			resolved === '.' ||
			resolved === 'apps' ||
			resolved.startsWith('apps/') ||
			resolved.split('/').includes('data') ||
			!isCopiedCodePath(resolved)
		)
			refuse(`${path} links to private or excluded files: ${target}`);
		const listed = await checkedGit(repository, [
			'ls-tree',
			'-z',
			commit,
			'--',
			resolved,
		]);
		if (!/^100[0-7]{3} blob /.test(listed))
			refuse(`${path} must link to a committed regular shared file: ${target}`);
		const mode = listed.slice(0, 6);
		// Two links can share a target; checkout-index refuses to overwrite its first copy.
		if (!(await info(join(tree, resolved))))
			await checkoutCodeFiles(repository, [{ path: resolved, mode }], tree, {
				lfsStorage,
			});
		await rm(file);
		await copyFile(join(tree, resolved), file);
		await chmod(file, mode === '100755' ? 0o755 : 0o644);
		materialized.push({ path, from: resolved });
	}
	// Lexical '..' normalization cannot account for an intermediate directory
	// link. Check effective targets after shared-file links have been replaced.
	const root = await realpath(join(tree, prefix));
	for (const { path, mode } of entries) {
		if (mode !== '120000' || !(await lstat(join(tree, path))).isSymbolicLink())
			continue;
		const resolved = await realpath(join(tree, path)).catch(
			(cause: NodeJS.ErrnoException) => {
				if (cause.code === 'ENOENT' || cause.code === 'ELOOP')
					refuse(
						`${path.slice(prefix.length + 1)} has a broken or cyclic link target`,
					);
				throw cause;
			},
		);
		if (!contains(root, resolved))
			refuse(`${path.slice(prefix.length + 1)} links outside the exported app`);
	}
	return materialized;
}

async function exportApp(
	app: string,
	directory: string,
	{
		repository,
		source,
		commit,
		lfsStorage,
		files,
	}: {
		repository: string;
		source: string;
		commit: string;
		lfsStorage: string;
		files: Awaited<ReturnType<typeof readCodeFiles>>;
	},
): Promise<ExportReport> {
	const previous = await destination(directory, app);
	const prefix = `apps/${app}/code`;
	const { entries, selected } = files;
	if (
		!entries.some(
			(entry) =>
				entry.path === `${prefix}/epicenter.ts` && entry.mode.startsWith('100'),
		)
	)
		refuse(
			`${app} has no committed code/epicenter.ts; commit its code before exporting`,
		);
	if (entries.some(({ mode }) => mode === '160000'))
		refuse(
			`${app} contains a gitlink; export code without embedded repositories`,
		);
	const work = await mkdtemp(join(dirname(directory), '.epicenter-export-'));
	let preserveWork = false;
	try {
		const tree = join(work, 'tree');
		await mkdir(tree);
		await checkoutCodeFiles(repository, selected, tree, { lfsStorage });
		const materialized = await materializeLinks(
			repository,
			commit,
			selected,
			tree,
			prefix,
			lfsStorage,
		);
		const output = join(tree, prefix);
		const nextDigest = await digest(output);
		const pending = await checkedGit(source, [
			'status',
			'--porcelain=v1',
			'-z',
			'--untracked-files=all',
			'--',
			prefix,
			...materialized.map(({ from }) => from),
		]);
		const report = {
			app,
			directory,
			materialized,
			uncommitted: pending !== '',
		};
		if (previous?.digest === nextDigest)
			return { ...report, status: 'unchanged' };
		await writeFile(
			join(output, EXPORT_MARKER),
			`${JSON.stringify({ app, digest: nextDigest }, null, 2)}\n`,
		);
		// Recheck immediately before replacing; staging can take time for a large app.
		await destination(directory, app);
		const backup = join(work, 'previous');
		const hadDirectory = Boolean(await info(directory));
		if (hadDirectory) await rename(directory, backup);
		let movedGit = false;
		try {
			if (hadDirectory && (await info(join(backup, '.git')))) {
				await rename(join(backup, '.git'), join(output, '.git'));
				movedGit = true;
			}
			await rename(output, directory);
		} catch (cause) {
			try {
				if (movedGit) await rename(join(output, '.git'), join(backup, '.git'));
				if (hadDirectory) await rename(backup, directory);
			} catch {
				preserveWork = true;
				throw new Error(
					`Export failed; recovery files are preserved under ${work}: ${extractErrorMessage(cause)}`,
				);
			}
			throw cause;
		}
		return { ...report, status: previous ? 'updated' : 'created' };
	} finally {
		if (!preserveWork) await rm(work, { recursive: true, force: true });
	}
}

/**
 * Export into an exact app directory, or one child per app with --all.
 * Repeating either invocation refreshes the same directories. No Git index,
 * ref, remote or working file in the live Epicenter is changed.
 */
export async function exportCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, { all: { type: 'boolean' } }, [1, 2]);
	if (!given || given.positionals.length !== (given.values.all ? 1 : 2))
		return fail(misuse('export'), json);
	const all = given.values.all === true;
	const app = all ? undefined : given.positionals[0];
	if (app !== undefined && nameProblem(app))
		return fail(misuse('export', nameProblem(app)), json);
	const directory = folderPath(given.positionals[all ? 0 : 1]!);
	let scratch: string | undefined;
	let held: Awaited<ReturnType<typeof hold>>;
	try {
		const source = await realpath(epicenterDir());
		await checkLocation(directory, source);
		const top = await git(source, ['rev-parse', '--show-toplevel']);
		if (top.code !== 0 || (await realpath(top.stdout)) !== source)
			refuse(
				'Export needs this Epicenter to be the root of its Git repository',
			);
		const head = await git(source, ['rev-parse', '--verify', 'HEAD']);
		if (head.code !== 0)
			refuse('This Epicenter has no commit to export; commit its code first');
		const commit = head.stdout;
		scratch = await mkdtemp(join(tmpdir(), 'epicenter-export-source-'));
		const repository = join(scratch, 'repository');
		await checkedGit(source, [
			'clone',
			'-q',
			'--shared',
			'--no-checkout',
			'--',
			source,
			repository,
		]);
		await checkedGit(repository, ['read-tree', commit]);
		const storage = await git(source, [
			'config',
			'--path',
			'--get',
			'lfs.storage',
		]);
		const lfsStorage =
			storage.code === 0
				? resolve(
						await checkedGit(source, ['rev-parse', '--absolute-git-dir']),
						storage.stdout,
					)
				: await checkedGit(source, [
						'rev-parse',
						'--path-format=absolute',
						'--git-path',
						'lfs',
					]);
		const candidates =
			app === undefined
				? (await git(repository, ['ls-tree', '-z', `${commit}:apps`])).stdout
						.split('\0')
						.filter(Boolean)
						.filter((entry) => entry.startsWith('040000 tree '))
						.map((entry) => entry.slice(entry.indexOf('\t') + 1))
						.filter((name) => nameProblem(name) === undefined)
				: [app];
		const apps = new Map<string, Awaited<ReturnType<typeof readCodeFiles>>>();
		for (const name of candidates.sort()) {
			const files = await readCodeFiles(repository, `apps/${name}/code`);
			if (!all || files.entries.length) apps.set(name, files);
		}
		const reports: ExportReport[] = [];
		if (all) {
			const entry = await info(directory);
			if (entry && !entry.isDirectory())
				refuse(`${directory} is not a real directory`);
			if (entry && (await info(join(directory, EXPORT_MARKER))))
				refuse(
					`${directory} is already a single-app export; choose a collection directory`,
				);
		}
		const parent = all ? directory : dirname(directory);
		await mkdir(parent, { recursive: true });
		held = await hold(parent, 0);
		if (!held)
			refuse(`${parent}: another export is using this directory; try again`);
		await checkInterrupted(parent);
		for (const [name, files] of apps) {
			const target = all ? join(directory, name) : directory;
			try {
				reports.push(
					await exportApp(name, target, {
						repository,
						source,
						commit,
						lfsStorage,
						files,
					}),
				);
			} catch (cause) {
				reports.push({
					app: name,
					directory: target,
					status: isRefused(cause) ? 'refused' : 'failed',
					problem: extractErrorMessage(cause),
				});
			}
		}
		if (all) {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (
					!entry.isDirectory() ||
					apps.has(entry.name) ||
					entry.name === '.git'
				)
					continue;
				const target = join(directory, entry.name);
				try {
					const marker = await readMarker(target);
					if (marker)
						reports.push({
							app: marker.app,
							directory: target,
							status: 'stale',
							problem: apps.has(marker.app)
								? `Extra export of ${marker.app}; its current export is ${join(directory, marker.app)}. This directory was left in place`
								: 'This app is absent from the committed source; its previous export was left in place',
						});
				} catch (cause) {
					reports.push({
						app: entry.name,
						directory: target,
						status: 'refused',
						problem: extractErrorMessage(cause),
					});
				}
			}
		}
		const omitted = all
			? (await homeEntries())
					.filter(({ entry }) => !apps.has(entry))
					.map(({ entry }) => entry)
			: [];
		if (json) writeJson({ commit, apps: reports, omitted });
		else {
			writeOut(`Exported source: ${commit}`);
			for (const report of reports) {
				writeOut(`${report.app}: ${report.status} (${report.directory})`);
				if (report.problem) writeErr(`${report.app}: ${report.problem}`);
				if (report.status === 'created' || report.status === 'updated')
					for (const file of report.materialized ?? [])
						writeOut(`  ${file.path}: copied shared file ${file.from}`);
				if (report.uncommitted)
					writeErr(
						`${report.app}: uncommitted source changes were not exported`,
					);
			}
			for (const name of omitted)
				writeErr(`${name}: no committed code tree; not exported`);
		}
		return reports.some(
			({ status }) =>
				status === 'refused' || status === 'failed' || status === 'stale',
		) || omitted.length
			? 1
			: 0;
	} catch (cause) {
		if (isRefused(cause))
			return fail(
				CliError.Refused({ message: extractErrorMessage(cause) }).error,
				json,
			);
		return fail(CliError.Internal({ cause }).error, json);
	} finally {
		held?.release();
		if (scratch) await rm(scratch, { recursive: true, force: true });
	}
}
