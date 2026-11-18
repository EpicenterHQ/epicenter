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
import {
	type Action,
	ActionError,
	type Actions,
	type App,
	defineApp,
	type Folder,
	folderOnDisk,
	isAction,
	isName,
	type NotStarted,
} from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { nameProblem } from './commands.ts';
import { appsDir, epicenterRoot } from './root.ts';

/** Where an entry is on disk: the same for an app that runs and one with problems. */
type Place = {
	/** The folder name in the Epicenter. */
	entry: string;
	/** The Epicenter entry's path before resolving links. */
	folder: string;
	/** The real directory whose code and data the runner uses. */
	realPath: string;
	codePath: string;
};

/**
 * An Epicenter entry as `epicenter` found it: an app that can run, with what
 * its `epicenter.ts` exports, or an entry with the problems that keep it from
 * running.
 */
type Located =
	| (Place & {
			ok: true;
			name: string;
			/** What the function `epicenter.ts` default-exports returned for the app's folder. */
			app: App;
			/** Every action by its words, one space apart, as the command line and MCP name it. */
			actions: Record<string, Action>;
	  })
	| (Place & { ok: false; problems: string[] });

/** An app that can run. */
export type Runnable = Extract<Located, { ok: true }>;

const CODE = 'code/epicenter.ts';

async function isFile(path: string) {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if (
			['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
				(error as NodeJS.ErrnoException).code ?? '',
			)
		)
			return false;
		throw error;
	}
}

async function entryAt(folder: string) {
	try {
		if (!(await stat(folder)).isDirectory()) return undefined;
		const realPath = await realpath(folder);
		const runnable = await isFile(join(realPath, CODE));
		const problem = runnable
			? undefined
			: (await lstat(join(realPath, 'code')).catch(() => undefined)) ||
					(await lstat(join(realPath, 'data')).catch(() => undefined))
				? 'code/epicenter.ts is missing'
				: undefined;
		if (!runnable && !problem) return undefined;
		const codePath = runnable
			? await realpath(join(realPath, 'code'))
			: join(realPath, 'code');
		return {
			folder,
			realPath,
			codePath,
			problem,
		};
	} catch (error) {
		if (
			['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
				(error as NodeJS.ErrnoException).code ?? '',
			)
		)
			return undefined;
		throw error;
	}
}

/** The entries in `apps/` that look like apps, sorted by name, without importing any of them; none when there is no `apps/`. */
export async function homeEntries() {
	const names = (
		await readdir(appsDir()).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return [] as string[];
			throw error;
		})
	)
		.filter((name) => !name.startsWith('.'))
		.sort();
	return (
		await Promise.all(
			names.map(async (entry) => {
				const found = await entryAt(join(appsDir(), entry));
				return found && { ...found, entry };
			}),
		)
	).filter((entry) => entry !== undefined);
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

async function load(
	place: NonNullable<Awaited<ReturnType<typeof entryAt>>>,
	entry: string,
): Promise<Located> {
	const at = { ...place, entry };
	const broken = (problems: string[]): Located => ({
		...at,
		ok: false,
		problems,
	});
	if (place.problem) return broken([place.problem]);
	const named = nameProblem(entry);
	if (named !== undefined)
		return broken([`its folder's name cannot name an app: ${named}`]);
	const thrown = (error: unknown) =>
		broken(
			extractErrorMessage(error)
				.split('\n')
				.map((line) => `${CODE}: ${line}`),
		);
	let module: { default?: unknown };
	try {
		forgetModules(place.codePath);
		module = await import(
			pathToFileURL(join(place.codePath, 'epicenter.ts')).href
		);
	} catch (error) {
		return thrown(error);
	}
	const exported = module.default;
	if (typeof exported !== 'function')
		return broken([`${CODE} does not export defineApp(...) by default`]);
	let app: App;
	let actions: Record<string, Action>;
	try {
		// Through `defineApp` again, so the call checks what the export returns, however it was made.
		app = defineApp(exported as (given: { folder: Folder }) => App)({
			folder: folderOnDisk(place.realPath),
		});
		actions = Object.fromEntries(byWords(app.actions));
	} catch (error) {
		return thrown(error);
	}
	return {
		...at,
		ok: true,
		name: entry,
		app,
		actions,
	};
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
 * Why the `local/` of the app `entry`, whose folder is `realPath`, could reach
 * Git, or undefined when it has no `local/` or the folder ignores itself
 * (ADR-0963). The fix is named, not made: the owner or an agent runs it.
 */
export async function localProblem(
	entry: string,
	realPath: string,
): Promise<string | undefined> {
	const local = join(realPath, 'local');
	if (!(await lstat(local).catch(() => undefined))?.isDirectory())
		return undefined;
	if (await lstat(join(local, '.gitignore')).catch(() => undefined))
		return undefined;
	return `apps/${entry}/local has no .gitignore; run: echo '*' > apps/${entry}/local/.gitignore`;
}

/**
 * Import every app entry independently so one broken app does not hide the
 * rest. An app whose `local/` does not ignore itself still runs, and is also
 * listed with that problem.
 */
export async function discoverAll() {
	const found = await homeEntries();
	const loaded = await Promise.all(
		found.map(async (entry) => ({
			located: await load(entry, entry.entry),
			local: await localProblem(entry.entry, entry.realPath),
		})),
	);
	return {
		epicenter: epicenterRoot().folder,
		apps: loaded.flatMap(({ located }) => (located.ok ? [located] : [])),
		problems: loaded.flatMap(({ located, local }) => {
			const problems = [
				...(located.ok ? [] : located.problems),
				...(local ? [local] : []),
			];
			if (!problems.length) return [];
			const { entry, folder, realPath, codePath } = located;
			return [
				{ entry, folder, realPath, codePath, ok: false as const, problems },
			];
		}),
	};
}

/** The listing keeps runnable apps separate from entries with problems. */
export type Discovery = Awaited<ReturnType<typeof discoverAll>>;

/** A name that finds no app in the Epicenter. */
const unknownApp = (name: string) =>
	ActionError.NotStarted({
		cause: 'usage',
		message: `Unknown app "${name}"`,
		next: 'epicenter',
	});

/** One entry as `homeEntries` lists it. */
type Entry = Awaited<ReturnType<typeof homeEntries>>[number];

/** The app entry named `name`, loaded or not, for a request that names one. */
export async function findEntry(
	name: string,
): Promise<Result<Entry, NotStarted>> {
	const entry = (await homeEntries()).find((entry) => entry.entry === name);
	return entry ? Ok(entry) : unknownApp(name);
}

/**
 * Load only the requested app entry so unrelated apps cannot affect a run.
 * An app that does not load answers its problems.
 */
export async function loadHomeApp(
	name: string,
): Promise<Result<Runnable, NotStarted>> {
	if (!isName(name)) return unknownApp(name);
	const found = await entryAt(join(appsDir(), name));
	if (!found) return unknownApp(name);
	const located = await load(found, name);
	if (located.ok) return Ok(located);
	return ActionError.NotStarted({
		cause: 'app-problems',
		message: `${name}: ${located.problems.join('; ')}`,
		app: name,
		problems: located.problems,
	});
}
