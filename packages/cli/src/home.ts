/**
 * The apps in the selected Epicenter (ADR-0841). A folder is an app when it
 * has an `epicenter.ts` whose default export is `defineApp(...)`. An app's
 * name is its entry in the Epicenter. Each entry loads on its own so a broken
 * app is listed without stopping the others: what its `define*` calls throw
 * while loading, and what is wrong with the shape of what it exports, are its
 * problems. A name that finds no app is a `CliError` with the next command as
 * data (ADR-0842).
 */
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	type Action,
	type Actions,
	type App,
	type Context,
	defineApp,
	isAction,
	isName,
} from '@epicenter/app';
import { Ok, type Result } from 'wellcrafted/result';
import { nameProblem } from './commands.ts';
import { folderOnDisk } from './disk.ts';
import { CliError } from './errors.ts';
import { epicenterDir, epicenterRoot } from './root.ts';

/** Where an entry is on disk: the same for an app that runs and one with problems. */
type Place = {
	/** The folder or link name in the Epicenter. */
	entry: string;
	/** The Epicenter entry's path before resolving links. */
	folder: string;
	/** The real directory whose code and data the runner uses. */
	realPath: string;
	/** The real target when the entry itself is a symlink, for the listing. */
	link?: string;
};

/**
 * An Epicenter entry as `epicenter` found it: an app that can run, with what
 * its `epicenter.ts` exports, or an entry with the problems that keep it from
 * running.
 */
export type Located =
	| (Place & {
			ok: true;
			name: string;
			/** What `epicenter.ts` default-exports. */
			app: App;
			/** Every action by its words, one space apart, as the command line and MCP name it. */
			actions: Record<string, Action>;
			/** The folder a run of its actions reaches. */
			context: Context;
	  })
	| (Place & { ok: false; problems: string[] });

/** An app that can run. */
export type Runnable = Extract<Located, { ok: true }>;

const CODE = 'epicenter.ts';

async function isFile(path: string) {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if (
			['ENOENT', 'ENOTDIR'].includes(
				(error as NodeJS.ErrnoException).code ?? '',
			)
		)
			return false;
		throw error;
	}
}

async function entryAt(folder: string) {
	try {
		const info = await lstat(folder);
		if (!info.isDirectory() && !info.isSymbolicLink()) return undefined;
		if (!(await stat(folder)).isDirectory()) return undefined;
		const realPath = await realpath(folder);
		if (!(await isFile(join(realPath, CODE)))) return undefined;
		return {
			folder,
			realPath,
			...(info.isSymbolicLink() ? { link: realPath } : {}),
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

/** The Epicenter's entries that look like apps, sorted by name, without importing any of them. */
export async function homeEntries() {
	const names = (await readdir(epicenterDir()))
		.filter((name) => !name.startsWith('.'))
		.sort();
	return (
		await Promise.all(
			names.map(async (entry) => {
				const found = await entryAt(join(epicenterDir(), entry));
				return found && { ...found, entry };
			}),
		)
	).filter((entry) => entry !== undefined);
}

/**
 * Drop every module this process loaded from under `folder`, its own
 * `node_modules` included, so the next import reads the files as they are
 * now (ADR-0880). A run already holding the old modules keeps them.
 * `@epicenter/app` is never under an app's folder: `bin.ts` supplies it.
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
	const named = nameProblem(entry);
	if (named !== undefined)
		return broken([`its folder's name cannot name an app: ${named}`]);
	const thrown = (error: unknown) =>
		broken(
			message(error)
				.split('\n')
				.map((line) => `${CODE}: ${line}`),
		);
	let module: { default?: unknown };
	try {
		forgetModules(place.realPath);
		module = await import(pathToFileURL(join(place.realPath, CODE)).href);
	} catch (error) {
		return thrown(error);
	}
	const exported = module.default;
	if (typeof exported !== 'object' || exported === null)
		return broken([`${CODE} does not export defineApp(...) by default`]);
	let app: App;
	let actions: Record<string, Action>;
	try {
		// `defineApp` returns what it is given once it has checked it, so this checks the export's whole shape.
		app = defineApp(exported as App);
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
		context: { folder: folderOnDisk(place.realPath) },
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

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/** Import every app entry independently so one broken app does not hide the rest. */
export async function discoverAll() {
	const found = await homeEntries();
	const loaded = await Promise.all(
		found.map((entry) => load(entry, entry.entry)),
	);
	return {
		epicenter: epicenterRoot().folder,
		apps: loaded.filter((located) => located.ok),
		problems: loaded.filter((located) => !located.ok),
	};
}

/** The listing keeps runnable apps separate from entries with problems. */
export type Discovery = Awaited<ReturnType<typeof discoverAll>>;

/** A name that finds no app in the Epicenter. */
const unknownApp = (name: string) =>
	CliError.Usage({ message: `Unknown app "${name}"`, next: 'epicenter' });

/** One entry as `homeEntries` lists it. */
export type Entry = Awaited<ReturnType<typeof homeEntries>>[number];

/**
 * Every app entry in the Epicenter, or only the one named, for a command
 * that works on each app or one.
 */
export async function chooseApps(
	name?: string,
): Promise<Result<Entry[], CliError>> {
	const entries = await homeEntries();
	if (name === undefined) return Ok(entries);
	const chosen = entries.filter((entry) => entry.entry === name);
	return chosen.length ? Ok(chosen) : unknownApp(name);
}

/** Load only the requested app entry so unrelated apps cannot affect a run. */
export async function loadHomeApp(
	name: string,
): Promise<Result<Located, CliError>> {
	if (!isName(name)) return unknownApp(name);
	const found = await entryAt(join(epicenterDir(), name));
	if (found) return Ok(await load(found, name));
	return unknownApp(name);
}
