/**
 * The apps in the selected Epicenter (ADR-0841). A folder is an app when it
 * has an `epicenter.ts` whose default export is `defineApp(...)`. An app's
 * name is its entry in the Epicenter. Each entry loads on its own so a broken
 * app is listed without stopping the others: what its `define*` calls throw
 * while loading are its problems. A name that finds no app is a `CliError`
 * with the next command as data (ADR-0842).
 */
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	type Action,
	type Actions,
	type App,
	type Context,
	isAction,
	isApp,
	isName,
} from '@epicenter/app';
import { Ok, type Result } from 'wellcrafted/result';
import { nameProblem } from './commands.ts';
import { folderOnDisk } from './disk.ts';
import { CliError } from './errors.ts';
import { epicenterDir, epicenterRoot } from './root.ts';
import { keychain, keychainService } from './secrets.ts';

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
			/** The folder and secrets a run of its actions reaches. */
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
	let module: { default?: unknown };
	try {
		module = await import(pathToFileURL(join(place.realPath, CODE)).href);
	} catch (error) {
		return broken(message(error).split('\n').map((line) => `${CODE}: ${line}`));
	}
	if (!isApp(module.default))
		return broken([`${CODE} does not export defineApp(...) by default`]);
	const app = module.default;
	return {
		...at,
		ok: true,
		name: entry,
		app,
		actions: Object.fromEntries(byWords(app.actions)),
		context: {
			folder: folderOnDisk(place.realPath),
			secrets: keychain(keychainService(epicenterRoot().id, entry)),
		},
	};
}

/** Every action nested in `actions`, by its words one space apart, in the order written. */
function byWords(actions: Actions, words: readonly string[] = []): [string, Action][] {
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

/** Load only the requested app entry so unrelated apps cannot affect a run. */
export async function loadHomeApp(
	name: string,
): Promise<Result<Located, CliError>> {
	const unknown = CliError.Usage({
		message: `Unknown app "${name}"`,
		next: 'epicenter',
	});
	if (!isName(name)) return unknown;
	const found = await entryAt(join(epicenterDir(), name));
	if (found) return Ok(await load(found, name));
	return unknown;
}
