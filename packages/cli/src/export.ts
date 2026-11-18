/** Export committed app code into replaceable directories, leaving publication to Git. */
import { lstatSync } from 'node:fs';
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
import {
	ActionError,
	type Answer,
	Err,
	type NotStarted,
	Ok,
	type Result,
} from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import {
	checkoutCodeFiles,
	EXPORT_MARKER,
	readCodeFiles,
} from './code-copy.js';
import { nameProblem, parseWords } from './commands.js';
import { checkedGit, git, isRepositoryTop } from './git.js';
import { homeEntries } from './home.js';
import { epicenterDir, folderPath } from './root.js';

type ExportMarker = { export: 'all' } | { export: 'app'; app: string };

/**
 * The source or the target does not allow this export, so it changed nothing.
 * The help says what each must be.
 */
const refuse = (message: string) =>
	ActionError.NotStarted({
		cause: 'usage',
		message,
		next: 'epicenter export --help',
	});

/** Resolve existing ancestors too, so aliases such as /tmp cannot bypass the boundary. */
async function canonical(path: string): Promise<string> {
	if (lstatSync(path, { throwIfNoEntry: false })) return realpath(path);
	return join(await canonical(dirname(path)), basename(path));
}

function contains(parent: string, child: string) {
	const path = relative(parent, child);
	return (
		path === '' ||
		(!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
	);
}

async function checkLocation(
	directory: string,
	source: string,
): Promise<Result<string, NotStarted>> {
	if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink())
		return refuse(
			`${directory} is a symbolic link; choose a real export directory`,
		);
	const resolved = await canonical(directory);
	if (contains(source, resolved) || contains(resolved, source))
		return refuse(
			`${directory} overlaps this Epicenter; export to a separate directory`,
		);
	if (resolved.split(sep).some((part) => part.toLowerCase() === '.git'))
		return refuse(`${directory} is inside Git's own files`);
	return Ok(resolved);
}

/** The marker grants overwrite permission; generated contents carry no independent state. */
async function checkDestination(
	directory: string,
	expected: ExportMarker,
): Promise<Result<undefined, NotStarted>> {
	const entry = lstatSync(directory, { throwIfNoEntry: false });
	if (!entry) return Ok(undefined);
	if (!entry.isDirectory())
		return refuse(`${directory} is not a real directory`);
	const path = join(directory, EXPORT_MARKER);
	const marker = lstatSync(path, { throwIfNoEntry: false });
	if (marker) {
		if (!marker.isFile() || marker.size > 1024)
			return refuse(`${path} must be a regular export marker`);
		let value: unknown;
		try {
			value = JSON.parse(await readFile(path, 'utf8'));
		} catch {
			return refuse(`${path} is not a valid export marker`);
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
			return refuse(
				`${directory} does not have a matching export marker; choose a new directory`,
			);
	} else if ((await readdir(directory)).some((name) => name !== '.DS_Store')) {
		return refuse(`${directory} is not empty and was not created by export`);
	}
	// Never follow directory links while checking or deleting generated contents.
	async function checkGit(
		folder: string,
	): Promise<Result<undefined, NotStarted>> {
		for (const entry of await readdir(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name);
			if (entry.name.toLowerCase() === '.git')
				return refuse(
					`${path} contains Git metadata; keep Git outside the export directory`,
				);
			if (entry.isDirectory()) {
				const inner = await checkGit(path);
				if (inner.error) return inner;
			}
		}
		return Ok(undefined);
	}
	return checkGit(directory);
}

/**
 * Refuse a link that leaves the app, or that is broken or cyclic. An app keeps
 * what it uses, its palette too, as files in code/, so nothing outside
 * travels.
 */
async function checkLinks(
	directory: string,
	entries: { path: string; mode: string }[],
	prefix: string,
): Promise<Result<undefined, NotStarted>> {
	const root = await realpath(directory);
	for (const { path, mode } of entries) {
		const relative = path.slice(prefix.length + 1);
		const file = join(root, relative);
		if (mode !== '120000' || !(await lstat(file)).isSymbolicLink()) continue;
		const target = await readlink(file);
		const lexical = posix.normalize(
			posix.join(posix.dirname(relative), target),
		);
		if (
			posix.isAbsolute(target) ||
			lexical === '..' ||
			lexical.startsWith('../')
		)
			return refuse(
				`${relative} links outside the app's code/: ${target}. Copy the file into code/ instead.`,
			);
		let resolved: string;
		try {
			resolved = await realpath(file);
		} catch (cause) {
			const { code } = cause as NodeJS.ErrnoException;
			if (code === 'ENOENT' || code === 'ELOOP')
				return refuse(`${relative} has a broken or cyclic link target`);
			throw cause;
		}
		if (!contains(root, resolved))
			return refuse(`${relative} links outside the exported app`);
	}
	return Ok(undefined);
}

/**
 * Regenerate one owned directory, holding all committed apps or one app.
 * It exports what `HEAD` holds and never commits, stages or pushes: an app
 * whose `code/` has uncommitted changes is refused. Repeating either
 * invocation refreshes the same directory.
 *
 * A refusal, or a failure before the directory is filled, changes nothing
 * and is `NotStarted`. A failure while filling it throws, and the CLI answers
 * `Threw`: the directory may be partly filled, and a rerun repairs it. An
 * `--all` export that left out apps with no committed code is `Problems`: it
 * exported the others, and its report names the apps it left out.
 */
export async function exportCommand(
	words: string[],
	json: boolean,
): Promise<Answer> {
	const { data: given, error: misused } = parseWords(
		'export',
		words,
		{ all: { type: 'boolean' } },
		[1, 2],
	);
	if (misused) return Err(misused);
	const all = given.values.all === true;
	if (given.positionals.length !== (all ? 1 : 2))
		return ActionError.NotStarted({
			cause: 'usage',
			message: all
				? 'export --all takes one directory'
				: 'export takes an app and a directory, or --all and a directory',
			next: 'epicenter export --help',
		});
	const app = all ? undefined : given.positionals[0];
	const problem = app === undefined ? undefined : nameProblem(app);
	if (problem)
		return ActionError.NotStarted({
			cause: 'usage',
			message: problem,
			next: 'epicenter export --help',
		});
	const directory = folderPath(given.positionals[all ? 0 : 1]!);
	let scratch: string | undefined;
	let filling = false;
	try {
		const source = await realpath(epicenterDir());
		const located = await checkLocation(directory, source);
		if (located.error) return located;

		const marker: ExportMarker =
			app === undefined ? { export: 'all' } : { export: 'app', app };
		const destination = await checkDestination(directory, marker);
		if (destination.error) return destination;
		if (!(await isRepositoryTop(source)))
			return refuse(`${source} is not a Git repository`);
		const head = await git(source, ['rev-parse', '--verify', 'HEAD']);
		if (head.code !== 0)
			return refuse(
				'This Epicenter has no commits; commit its code, then export.',
			);
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
				return refuse(
					`${code} has uncommitted changes; commit them, then export.`,
				);
			if (
				!entries.some(
					({ path, mode }) =>
						path === `apps/${app}/code/epicenter.ts` && mode.startsWith('100'),
				)
			)
				return refuse(
					`${app} has no committed code/epicenter.ts; commit its code before exporting`,
				);
			if (entries.some(({ mode }) => mode === '160000'))
				return refuse(
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
			// A random root also catches chains that leave and reenter a folder named code.
			const prepared = await mkdtemp(join(scratch, 'app-'));
			await rename(join(tree, prefix), prepared);
			const links = await checkLinks(prepared, selected, prefix);
			if (links.error) return links;
			await rename(prepared, all ? join(output, app) : output);
		}
		const omitted = all
			? (await homeEntries())
					.filter(({ entry }) => !apps.some(({ app }) => app === entry))
					.map(({ entry }) => entry)
			: [];
		const relocated = await checkLocation(directory, source);
		if (relocated.error) return relocated;
		await mkdir(directory, { recursive: true });
		const redestined = await checkDestination(directory, marker);
		if (redestined.error) return redestined;
		filling = true;
		// Keep ownership through interruption: a rerun repairs an incomplete fill.
		if (!lstatSync(join(directory, EXPORT_MARKER), { throwIfNoEntry: false }))
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
		const exported = [
			`Exported ${apps.length} app${apps.length === 1 ? '' : 's'} to ${directory}`,
			`Exported source: ${commit}`,
		];
		if (omitted.length)
			return ActionError.Problems({
				message: omitted
					.map((name) => `${name}: no committed code tree; not exported`)
					.join('\n'),
				report: json
					? { commit, directory, apps: apps.map(({ app }) => app), omitted }
					: exported.join('\n'),
			});
		return Ok(
			json
				? { commit, directory, apps: apps.map(({ app }) => app) }
				: exported.join('\n'),
		);
	} catch (cause) {
		if (filling) throw cause;
		return ActionError.NotStarted({
			cause: 'internal',
			message: extractErrorMessage(cause),
		});
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
	}
}
