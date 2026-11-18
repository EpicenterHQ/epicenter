/**
 * The apps in the selected Epicenter (ADR-0841), each a folder in its `apps/`
 * A folder there is an app when it has a `code/epicenter.ts` whose
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
import { isAction } from '../action.ts';
import {
	type Action,
	ActionError,
	type Actions,
	type App,
	defineApp,
	type Folder,
	folderOnDisk,
	isName,
	type NotStarted,
} from '../index.ts';
import type { EpicenterRoot } from './root.ts';

/** The words the `epicenter` command keeps for itself, which no app may be named. */
export const COMMAND_WORDS = ['check', 'serve'] as const;

/**
 * Why `name` cannot name an app, or `undefined` when it can: it must be
 * lowercase letters, digits, and dashes, starting with a letter, and not a
 * word the `epicenter` command keeps for itself.
 */
export function nameProblem(name: unknown): string | undefined {
	if (!isName(name))
		return `${JSON.stringify(name)} is not lowercase letters, digits, and dashes, starting with a letter`;
	if ((COMMAND_WORDS as readonly string[]).includes(name))
		return `"${name}" is an epicenter command`;
	return undefined;
}

/** An app's folder in `apps/`, found without importing its code. */
export type AppFolder = {
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
export type LoadedApp = AppFolder & {
	/** What the function `epicenter.ts` default-exports returned for the app's folder. */
	app: App;
	/** Every action by its words, one space apart, as the command line names it. */
	actions: Record<string, Action>;
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

/** The app folder `name` in `apps/`, or undefined when that folder does not look like an app. */
async function appFolder(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
): Promise<AppFolder | undefined> {
	const folder = join(appsIn(root), name);
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
export async function homeEntries(
	root: Pick<EpicenterRoot, 'folder'>,
): Promise<AppFolder[]> {
	const names = (
		await readdir(appsIn(root)).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return [] as string[];
			throw error;
		})
	)
		.filter((name) => !name.startsWith('.'))
		.sort();
	const found = await Promise.all(names.map((name) => appFolder(root, name)));
	return found.filter((each) => each !== undefined);
}

/**
 * Drop every module this process loaded from under `folder`, so the next
 * import reads the files as they are now (ADR-0880). A run already holding
 * the old modules keeps them. The packages an app imports are in the home's
 * top `node_modules/`, outside its folder, so a changed package shows only
 * after this process restarts; `@epicenter/app` is one of them.
 */
function forgetModules(folder: string) {
	const inside = `${folder}${sep}`;
	for (const path of Object.keys(require.cache))
		if (path.startsWith(inside)) delete require.cache[path];
}

/** Import an app folder's code: the app it defines, or the problems that keep it from loading. */
async function load(found: AppFolder): Promise<Result<LoadedApp, string[]>> {
	if (found.problem) return Err([found.problem]);
	const named = nameProblem(found.name);
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
		forgetModules(found.codePath);
		module = await import(
			pathToFileURL(join(found.codePath, 'epicenter.ts')).href
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
			folder: folderOnDisk(found.realPath),
		});
		return Ok({
			...found,
			app,
			actions: Object.fromEntries(byWords(app.actions)),
		});
	} catch (error) {
		return thrown(error);
	}
}

/** Every action nested in `actions`, by its words one space apart, in the order written. */
function byWords(
	actions: Actions,
	words: readonly string[] = [],
): [string, Action][] {
	return Object.entries(actions).flatMap(([word, entry]) =>
		isAction(entry)
			? [[[...words, word].join(' '), entry] as [string, Action]]
			: byWords(entry as Actions, [...words, word]),
	);
}

/**
 * Why the `local/` of the app `name`, whose folder is `realPath`, could reach
 * Git, or undefined when it has no `local/` or the folder ignores itself
 * (ADR-0963). The fix is named, not made: the owner or an agent runs it.
 */
export async function localProblem({
	name,
	realPath,
}: AppFolder): Promise<string | undefined> {
	const local = join(realPath, 'local');
	if (!(await lstat(local).catch(() => undefined))?.isDirectory())
		return undefined;
	if (await lstat(join(local, '.gitignore')).catch(() => undefined))
		return undefined;
	return `apps/${name}/local has no .gitignore; run: echo '*' > apps/${name}/local/.gitignore`;
}

/**
 * Import every app independently so one broken app does not hide the rest.
 * An app whose `local/` does not ignore itself still runs, and is also
 * listed with that problem.
 */
export async function discoverAll(root: Pick<EpicenterRoot, 'folder'>) {
	const loaded = await Promise.all(
		(await homeEntries(root)).map(async (found) => ({
			name: found.name,
			result: await load(found),
			local: await localProblem(found),
		})),
	);
	return {
		apps: loaded.flatMap(({ result }) => (result.data ? [result.data] : [])),
		problems: loaded.flatMap(({ name, result, local }) => {
			const problems = [...(result.error ?? []), ...(local ? [local] : [])];
			return problems.length ? [{ name, problems }] : [];
		}),
	};
}

/** A name that finds no app in the Epicenter. */
const unknownApp = (name: string) =>
	ActionError.NotStarted({
		cause: 'usage',
		message: `Unknown app "${name}"`,
		next: 'epicenter',
	});

/** The app folder named `name`, loaded or not, for a request that names one. */
export async function findEntry(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
): Promise<AppFolder | undefined> {
	return isName(name) ? appFolder(root, name) : undefined;
}

/**
 * Load only the requested app so unrelated apps cannot affect a run. An app
 * that does not load answers its problems.
 */
export async function loadHomeApp(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
): Promise<Result<LoadedApp, NotStarted>> {
	const found = await findEntry(root, name);
	if (!found) return unknownApp(name);
	const { data: loaded, error: problems } = await load(found);
	if (loaded) return Ok(loaded);
	return ActionError.NotStarted({
		cause: 'app-problems',
		message: `${name}: ${problems.join('; ')}`,
		app: name,
		problems,
	});
}
