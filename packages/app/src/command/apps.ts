/**
 * The apps in an Epicenter (ADR-0841), each a folder in its `apps/`. A
 * folder there is an app when it has a `code/epicenter.ts` whose
 * default export is `defineApp(...)`. An app's name is its folder's name in
 * `apps/`. Each entry loads on its own so a broken
 * app is listed without stopping the others: what its `define*` calls throw
 * while loading, and what is wrong with the shape of what it exports, are its
 * problems. A name that finds no app is `NotStarted` with the next command as
 * data (ADR-0842, ADR-0953).
 */
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type App,
	defineApp,
	type Folder,
	folderOnDisk,
	isName,
	type NotStarted,
} from '../index.ts';
import { appProblems, unknownApp } from './protocol.ts';
import { appDir, appPath, type EpicenterRoot } from './root.ts';

/** The words the `epicenter` command keeps for itself, which no app may be named. */
export const COMMAND_WORDS = ['check', 'serve'] as const;

/**
 * Why `name` cannot name an app, or `undefined` when it can: it must be
 * lowercase letters, digits, and dashes, starting with a letter, and not a
 * word the `epicenter` command keeps for itself.
 */
function nameProblem(name: unknown): string | undefined {
	if (!isName(name))
		return `${JSON.stringify(name)} is not lowercase letters, digits, and dashes, starting with a letter`;
	if ((COMMAND_WORDS as readonly string[]).includes(name))
		return `"${name}" is an epicenter command`;
	return undefined;
}

/** An entry in `apps/` that looks like an app, found without importing its code. */
export type AppEntry = {
	/** Its folder's name in `apps/`, which is the app's name. */
	name: string;
	/** The real folder whose code and data the app uses. */
	realPath: string;
	/** The real path of its `code/`. */
	codePath: string;
	/** Why it cannot load, found before importing it. */
	problem?: string;
};

/** An app whose code loaded. */
export type LoadedApp = AppEntry & {
	/** What the function `epicenter.ts` default-exports returned for the app's folder. */
	app: App;
};

const CODE = 'code/epicenter.ts';

/** Whether a failed read means only that nothing usable is there. */
const isAbsent = (error: unknown) =>
	['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
		(error as NodeJS.ErrnoException).code ?? '',
	);

async function isFile(path: string) {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if (isAbsent(error)) return false;
		throw error;
	}
}

/** The Epicenter's `apps/`, which holds its apps, each holding code/, data/ and local/. */
const appsIn = ({ folder }: Pick<EpicenterRoot, 'folder'>) =>
	join(folder, 'apps');


/** An entry's problems: it did not load, a read failed, or its `local/` could reach Git. */
export type AppProblems = { entry: string; problems: string[] };

/** The entry `name` in `apps/`, or undefined when it does not look like an app. */
async function appEntry(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
): Promise<AppEntry | undefined> {
	const folder = appPath(root, name);
	try {
		if (!(await stat(folder)).isDirectory()) return undefined;
		const realPath = await realpath(folder);
		if (await isFile(join(realPath, CODE)))
			return {
				name,
				realPath,
				codePath: await realpath(join(realPath, 'code')),
			};
		const started =
			(await lstat(join(realPath, 'code')).catch(() => undefined)) ||
			(await lstat(join(realPath, 'data')).catch(() => undefined));
		if (!started) return undefined;
		return {
			name,
			realPath,
			codePath: join(realPath, 'code'),
			problem: 'code/epicenter.ts is missing',
		};
	} catch (error) {
		if (isAbsent(error)) return undefined;
		throw error;
	}
}

/** The folders in `apps/` that look like apps, sorted by name, without importing any of them; none when there is no `apps/`. */
export async function appEntries(
	root: Pick<EpicenterRoot, 'folder'>,
): Promise<AppEntry[]> {
	const names = (
		await readdir(appsIn(root)).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return [] as string[];
			throw error;
		})
	)
		.filter((name) => !name.startsWith('.'))
		.sort();
	const entries = await Promise.all(names.map((name) => appEntry(root, name)));
	return entries.filter((each) => each !== undefined);
}

/**
 * Drop every module this process loaded from under `folder`, so the next
 * import reads the files as they are now (ADR-0880). A run already holding
 * the old modules keeps them. The packages an app imports are in the Epicenter's
 * top `node_modules/`, outside its folder, so a changed package shows only
 * after this process restarts; `@epicenter/app` is one of them.
 */
function forgetModules(folder: string) {
	const inside = `${folder}${sep}`;
	for (const path of Object.keys(require.cache))
		if (path.startsWith(inside)) delete require.cache[path];
}

/** Import an entry's code: the app it defines, or the problems that keep it from loading. */
async function load(entry: AppEntry): Promise<Result<LoadedApp, string[]>> {
	if (entry.problem) return Err([entry.problem]);
	const named = nameProblem(entry.name);
	if (named !== undefined)
		return Err([`its folder's name cannot name an app: ${named}`]);
	const thrown = (error: unknown) =>
		Err(
			extractErrorMessage(error)
				.split('\n')
				.map((line) => `${CODE}: ${line}`),
		);
	let module: { default?: unknown };
	try {
		forgetModules(entry.codePath);
		module = await import(
			pathToFileURL(join(entry.codePath, 'epicenter.ts')).href
		);
	} catch (error) {
		return thrown(error);
	}
	const exported = module.default;
	if (typeof exported !== 'function')
		return Err([`${CODE} does not export defineApp(...) by default`]);
	try {
		// Through `defineApp` again, so the call checks what the export returns, however it was made.
		const app = defineApp(exported as (given: { folder: Folder }) => App)({
			folder: folderOnDisk(entry.realPath),
		});
		return Ok({ ...entry, app });
	} catch (error) {
		return thrown(error);
	}
}

/**
 * Why the `local/` of the app `name`, whose folder is `realPath`, could reach
 * Git, or undefined when it has no `local/` or the folder ignores itself
 * (ADR-0963). The fix is named, not made: the owner or an agent runs it.
 */
export async function localProblem({
	name,
	realPath,
}: AppEntry): Promise<string | undefined> {
	const local = join(realPath, 'local');
	if (!(await lstat(local).catch(() => undefined))?.isDirectory())
		return undefined;
	if (await lstat(join(local, '.gitignore')).catch(() => undefined))
		return undefined;
	const named = `${appDir(name)}/local`;
	return `${named} has no .gitignore; run: echo '*' > ${named}/.gitignore`;
}

/**
 * Import every app independently so one broken app does not hide the rest.
 * An app whose `local/` does not ignore itself still runs, and is also
 * listed with that problem.
 */
export async function discoverAll(
	root: Pick<EpicenterRoot, 'folder'>,
): Promise<{ apps: LoadedApp[]; problems: AppProblems[] }> {
	const loaded = await Promise.all(
		(await appEntries(root)).map(async (entry) => ({
			name: entry.name,
			result: await load(entry),
			local: await localProblem(entry),
		})),
	);
	return {
		apps: loaded.flatMap(({ result }) => (result.data ? [result.data] : [])),
		problems: loaded.flatMap(({ name, result, local }) => {
			const problems = [...(result.error ?? []), ...(local ? [local] : [])];
			return problems.length ? [{ entry: name, problems }] : [];
		}),
	};
}

/** The entry named `name`, loaded or not, for a request that names one. */
export async function findEntry(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
): Promise<AppEntry | undefined> {
	return isName(name) ? appEntry(root, name) : undefined;
}

/**
 * Load only the requested app so unrelated apps cannot affect a run. An app
 * that does not load answers its problems.
 */
export async function loadApp(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
): Promise<Result<LoadedApp, NotStarted>> {
	const entry = await findEntry(root, name);
	if (!entry) return unknownApp(name);
	return loadEntry(entry);
}

/** Load an entry already found: the app, or its problems as a refusal. */
export async function loadEntry(
	entry: AppEntry,
): Promise<Result<LoadedApp, NotStarted>> {
	const { data: loaded, error: problems } = await load(entry);
	if (loaded) return Ok(loaded);
	return appProblems(entry.name, problems);
}
