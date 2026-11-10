/**
 * The apps in the selected Epicenter (ADR-0841, ADR-0857). A folder is an
 * app when it has an `epicenter.json`; its `epicenter.ts`, when present, adds
 * code. An app's name is its entry in the Epicenter. Each entry loads on its
 * own so a broken app is listed without stopping the others. A name that finds no app is a
 * `CliError` with the next command as data (ADR-0842).
 */
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	type Action,
	type App,
	appActions,
	type Declaration,
	isName,
	nameProblem,
	problemsOf,
} from '@epicenter/app';
import { Ok, type Result } from 'wellcrafted/result';
import { CliError } from './errors.ts';
import { epicenterDir, epicenterRoot } from './root.ts';

/** Where an entry is on disk: the same for an app that runs and one with problems. */
type Place = {
	/** The folder or link name in the Epicenter. */
	entry: string;
	/** The Epicenter entry's path before resolving links. */
	folder: string;
	/** The real directory whose declaration, code, and data the runner uses. */
	realPath: string;
	/** The real target when the entry itself is a symlink, for the listing. */
	link?: string;
};

/**
 * An Epicenter entry as `epicenter` found it: an app that can run, with
 * its `epicenter.json` as read from disk and its code's actions, or an entry
 * with the problems that keep it from running.
 */
export type Located =
	| (Place & {
			ok: true;
			name: string;
			/** The parsed `epicenter.json`: the one source of the app's description and collections. */
			declaration: Declaration;
			/** Each collection's actions, with `epicenter.ts`'s laid over them. */
			actions: Record<string, Action>;
	  })
	| (Place & { ok: false; problems: string[] });

/** An app that can run. */
export type Runnable = Extract<Located, { ok: true }>;

const DECLARATION = 'epicenter.json';
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
		const declared = await isFile(join(realPath, DECLARATION));
		const code = await isFile(join(realPath, CODE));
		if (!declared && !code) return undefined;
		return {
			folder,
			realPath,
			code,
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

async function entries() {
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

/** `folder`'s `epicenter.json`, parsed and checked, or what is wrong with it. Imports no code. */
export async function readDeclaration(
	folder: string,
): Promise<{ declaration: Declaration } | { problems: string[] }> {
	let declaration: unknown;
	try {
		declaration = JSON.parse(await readFile(join(folder, DECLARATION), 'utf8'));
	} catch (error) {
		return {
			problems: [
				(error as NodeJS.ErrnoException).code === 'ENOENT'
					? `has no ${DECLARATION}`
					: `${DECLARATION} is not JSON: ${message(error)}`,
			],
		};
	}
	const problems = problemsOf(declaration);
	return problems.length
		? { problems }
		: { declaration: declaration as Declaration };
}

async function load(
	{ code, ...place }: NonNullable<Awaited<ReturnType<typeof entryAt>>>,
	entry: string,
): Promise<Located> {
	const at = { ...place, entry };
	const broken = (problems: string[]): Located => ({
		...at,
		ok: false,
		problems,
	});
	// An invalid declaration is reported before any of the app's code runs.
	const read = await readDeclaration(place.realPath);
	if ('problems' in read) return broken(read.problems);
	const { declaration } = read;
	const name = entry;
	let module: { default?: unknown } | undefined;
	if (code) {
		try {
			module = await import(pathToFileURL(join(place.realPath, CODE)).href);
		} catch (error) {
			return broken([`importing ${CODE} threw: ${message(error)}`]);
		}
	}
	const problems = problemsOf(declaration, module && (module.default ?? null));
	const named = nameProblem(entry);
	if (named !== undefined)
		problems.unshift(`its folder's name cannot name an app: ${named}`);
	if (problems.length) return broken(problems);
	return {
		...at,
		ok: true,
		name,
		declaration,
		actions: appActions(declaration, module?.default as App | undefined),
	};
}

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/** The Epicenter's entries that look like apps, sorted by name, without importing any of them. */
export async function homeEntries() {
	return entries();
}

/** Import every app entry independently so one broken app does not hide the rest. */
export async function discoverAll() {
	const found = await entries();
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
