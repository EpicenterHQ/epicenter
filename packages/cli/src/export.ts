/** Export committed app code into replaceable directories, leaving publication to Git. */
import {
	cp,
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
	readCodeFiles,
} from './code-copy.js';
import { misuse, nameProblem, parseWords } from './commands.js';
import { CliError } from './errors.js';
import { checkedGit, git, isRepositoryTop } from './git.js';
import { homeEntries } from './home.js';
import { fail, writeErr, writeJson, writeOut } from './output.js';
import { epicenterDir, folderPath } from './root.js';

type ExportMarker = { export: 'all' } | { export: 'app'; app: string };

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

/** The marker grants overwrite permission; generated contents carry no independent state. */
async function checkDestination(directory: string, expected: ExportMarker) {
	const entry = await info(directory);
	if (!entry) return;
	if (!entry.isDirectory()) refuse(`${directory} is not a real directory`);
	const path = join(directory, EXPORT_MARKER);
	const marker = await info(path);
	if (marker) {
		if (!marker.isFile() || marker.size > 1024)
			refuse(`${path} must be a regular export marker`);
		let value: unknown;
		try {
			value = JSON.parse(await readFile(path, 'utf8'));
		} catch {
			refuse(`${path} is not a valid export marker`);
		}
		if (
			typeof value !== 'object' ||
			value === null ||
			!('export' in value) ||
			value.export !== expected.export ||
			Object.keys(value).length !== (expected.export === 'app' ? 2 : 1) ||
			(expected.export === 'app' &&
				(!('app' in value) || value.app !== expected.app))
		)
			refuse(
				`${directory} does not have a matching export marker; choose a new directory`,
			);
	} else if ((await readdir(directory)).some((name) => name !== '.DS_Store')) {
		refuse(`${directory} is not empty and was not created by export`);
	}
	// Never follow directory links while checking or deleting generated contents.
	async function checkGit(folder: string) {
		for (const entry of await readdir(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name);
			if (entry.name.toLowerCase() === '.git')
				refuse(
					`${path} contains Git metadata; keep Git outside the export directory`,
				);
			if (entry.isDirectory()) await checkGit(path);
		}
	}
	await checkGit(directory);
}

/**
 * Refuse a link whose target leaves the app's code/. An app keeps what it
 * uses, its palette too, as files in code/, so nothing outside travels.
 */
async function refuseOutsideLinks(
	entries: { path: string; mode: string }[],
	tree: string,
	prefix: string,
) {
	for (const entry of entries.filter(({ mode }) => mode === '120000')) {
		const target = await readlink(join(tree, entry.path));
		const resolved = posix.normalize(
			posix.join(posix.dirname(entry.path), target),
		);
		if (
			posix.isAbsolute(target) ||
			(resolved !== prefix && !resolved.startsWith(`${prefix}/`))
		)
			refuse(
				`${entry.path.slice(prefix.length + 1)} links outside the app's code/: ${target}. Copy the file into code/ instead.`,
			);
	}
}

/** Validate links independently of the checkout's code/ or collection app name. */
async function checkLinks(
	directory: string,
	entries: { path: string; mode: string }[],
	prefix: string,
) {
	const root = await realpath(directory);
	for (const { path, mode } of entries) {
		const relative = path.slice(prefix.length + 1);
		const file = join(root, relative);
		if (mode !== '120000' || !(await lstat(file)).isSymbolicLink()) continue;
		const resolved = await realpath(file).catch(
			(cause: NodeJS.ErrnoException) => {
				if (cause.code === 'ENOENT' || cause.code === 'ELOOP')
					refuse(`${relative} has a broken or cyclic link target`);
				throw cause;
			},
		);
		if (!contains(root, resolved))
			refuse(`${relative} links outside the exported app`);
	}
}

/**
 * Regenerate one owned directory, holding all committed apps or one app.
 * It exports what `HEAD` holds and never commits, stages or pushes: an app
 * whose `code/` has uncommitted changes is refused. Repeating either
 * invocation refreshes the same directory.
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
	try {
		const source = await realpath(epicenterDir());
		await checkLocation(directory, source);

		const marker: ExportMarker =
			app === undefined ? { export: 'all' } : { export: 'app', app };
		await checkDestination(directory, marker);
		if (!(await isRepositoryTop(source)))
			refuse(`${source} is not a Git repository`);
		const head = await git(source, ['rev-parse', '--verify', 'HEAD']);
		if (head.code !== 0)
			refuse('This Epicenter has no commits; commit its code, then export.');
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
		const apps: ({ app: string } & Awaited<
			ReturnType<typeof readCodeFiles>
		>)[] = [];
		for (const name of candidates.sort()) {
			const files = await readCodeFiles(repository, `apps/${name}/code`);
			if (!all || files.entries.length) apps.push({ app: name, ...files });
		}
		for (const { app, entries } of apps) {
			// Git's own answer, so its ignore rules decide what counts as a change.
			const code = `apps/${app}/code`;
			if (
				await checkedGit(source, [
					'status',
					'--porcelain',
					'--untracked-files=all',
					'--',
					code,
				])
			)
				refuse(`${code} has uncommitted changes; commit them, then export.`);
			if (
				!entries.some(
					({ path, mode }) =>
						path === `apps/${app}/code/epicenter.ts` && mode.startsWith('100'),
				)
			)
				refuse(
					`${app} has no committed code/epicenter.ts; commit its code before exporting`,
				);
			if (entries.some(({ mode }) => mode === '160000'))
				refuse(
					`${app} contains a gitlink; export code without embedded repositories`,
				);
		}
		const tree = join(scratch, 'tree');
		const output = join(scratch, 'output');
		await mkdir(tree);
		await mkdir(output);
		await checkoutCodeFiles(
			repository,
			apps.flatMap(({ selected }) => selected),
			tree,
			{ lfsStorage },
		);
		for (const { app, selected } of apps) {
			const prefix = `apps/${app}/code`;
			await refuseOutsideLinks(selected, tree, prefix);
			// A random root also catches chains that leave and reenter a folder named code.
			const prepared = await mkdtemp(join(scratch, 'app-'));
			await rename(join(tree, prefix), prepared);
			await checkLinks(prepared, selected, prefix);
			await rename(prepared, all ? join(output, app) : output);
		}
		const omitted = all
			? (await homeEntries())
					.filter(({ entry }) => !apps.some(({ app }) => app === entry))
					.map(({ entry }) => entry)
			: [];
		await checkLocation(directory, source);
		await mkdir(directory, { recursive: true });
		await checkDestination(directory, marker);
		// Keep ownership through interruption: a rerun repairs an incomplete fill.
		if (!(await info(join(directory, EXPORT_MARKER))))
			await writeFile(
				join(directory, EXPORT_MARKER),
				`${JSON.stringify(marker)}\n`,
				{ flag: 'wx' },
			);
		for (const name of await readdir(directory)) {
			if (name !== EXPORT_MARKER)
				await rm(join(directory, name), { recursive: true, force: true });
		}
		await cp(output, directory, { recursive: true, verbatimSymlinks: true });
		if (json)
			writeJson({
				commit,
				directory,
				apps: apps.map(({ app }) => app),
				omitted,
			});
		else {
			writeOut(
				`Exported ${apps.length} app${apps.length === 1 ? '' : 's'} to ${directory}`,
			);
			writeOut(`Exported source: ${commit}`);
			for (const name of omitted)
				writeErr(`${name}: no committed code tree; not exported`);
		}
		return omitted.length ? 1 : 0;
	} catch (cause) {
		if (isRefused(cause))
			return fail(
				CliError.Refused({ message: extractErrorMessage(cause) }).error,
				json,
			);
		return fail(CliError.Internal({ cause }).error, json);
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
	}
}
