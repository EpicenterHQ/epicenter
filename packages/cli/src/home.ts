/**
 * The app home and folders run by path (ADR-0841, ADR-0857). A folder is an
 * app when it has an `epicenter.json`; its `epicenter.ts`, when present, adds
 * code. Each entry loads on its own so a broken app is listed without stopping
 * the others. A name or path that finds no app is a `CliError` with the next
 * command as data (ADR-0842).
 */
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	type Action,
	type CodeCollection,
	type Declaration,
	isName,
	problemsOf,
} from '@epicenter/app';
import { Ok, type Result } from 'wellcrafted/result';
import { CliError } from './errors.ts';

/** Where an entry is on disk: the same for an app that runs and one with problems. */
type Place = {
	/** The folder or link name in the home; absent for a folder run by path. */
	entry?: string;
	/** The home entry's path, or the explicit folder path, before resolving links. */
	folder: string;
	/** The real directory whose declaration, code, and data the runner uses. */
	realPath: string;
	/** The real target when the entry itself is a symlink, for the listing. */
	link?: string;
};

/**
 * A home entry or folder as `epicenter` found it: an app that can run, with
 * its `epicenter.json` as read from disk and its code's collections and
 * actions, or an entry with the problems that keep it from running.
 */
export type Located =
	| (Place & {
			ok: true;
			name: string;
			/** The parsed `epicenter.json`: the one source of the app's name, description, and declared collections. */
			declaration: Declaration;
			/** Collections `epicenter.ts` introduces; empty without code. */
			collections: Record<string, CodeCollection>;
			/** `epicenter.ts`'s actions; empty without code. */
			actions: Record<string, Action>;
	  })
	| (Place & { ok: false; problems: string[] });

/** An app that can run. */
export type Runnable = Extract<Located, { ok: true }>;

/** `~/Epicenter`: the only list of apps (ADR-0849). Tests move it by setting `HOME`. */
export function homeDir(): string {
	return join(homedir(), 'Epicenter');
}

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
	try {
		const names = (await readdir(homeDir()))
			.filter((name) => !name.startsWith('.'))
			.sort();
		return {
			missing: false,
			entries: (
				await Promise.all(
					names.map(async (entry) => {
						const found = await entryAt(join(homeDir(), entry));
						return found && { ...found, entry };
					}),
				)
			).filter((entry) => entry !== undefined),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return { missing: true, entries: [] };
		throw error;
	}
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
	entry?: string,
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
	const { name } = declaration;
	let module: { default?: unknown } | undefined;
	if (code) {
		try {
			module = await import(pathToFileURL(join(place.realPath, CODE)).href);
		} catch (error) {
			return broken([`importing ${CODE} threw: ${message(error)}`]);
		}
	}
	const problems = problemsOf(declaration, module && (module.default ?? null));
	if (entry !== undefined && name !== entry)
		problems.push(`declares the name "${name}" but its folder is "${entry}"`);
	if (problems.length) return broken(problems);
	const app = module?.default as
		| {
				collections: Record<string, CodeCollection>;
				actions: Record<string, Action>;
		  }
		| undefined;
	return {
		...at,
		ok: true,
		name,
		declaration,
		collections: app?.collections ?? {},
		actions: app?.actions ?? {},
	};
}

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/** The names of the home's entries that look like apps, sorted, without importing any of them. */
export async function entryNames() {
	return (await entries()).entries.map(({ entry }) => entry);
}

/**
 * Import every home entry independently so one broken app does not hide the
 * rest. Each entry must declare its own folder's name, so two entries can
 * never both run under one name.
 */
export async function discoverAll() {
	const found = await entries();
	const loaded = await Promise.all(
		found.entries.map((entry) => load(entry, entry.entry)),
	);
	return {
		home: homeDir(),
		missing: found.missing,
		apps: loaded.filter((located) => located.ok),
		problems: loaded.filter((located) => !located.ok),
	};
}

/** The home listing keeps runnable apps separate from entries with problems. */
export type Discovery = Awaited<ReturnType<typeof discoverAll>>;

/** Load only the requested home entry so unrelated apps cannot affect a run. */
export async function loadHomeApp(
	name: string,
): Promise<Result<Located, CliError>> {
	const unknown = CliError.Usage({
		message: `Unknown app "${name}"`,
		next: 'epicenter',
	});
	if (!isName(name)) return unknown;
	const found = await entryAt(join(homeDir(), name));
	if (found) return Ok(await load(found, name));
	try {
		await stat(homeDir());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return CliError.Usage({
				message: `Unknown app "${name}". There is no Epicenter home at ${homeDir()}. Make one with: mkdir ${homeDir()}`,
				next: `mkdir ${homeDir()}`,
			});
		throw error;
	}
	return unknown;
}

/** Recognize explicit folder spellings while leaving app names unambiguous. */
export function isFolderPath(value: string): boolean {
	return (
		['.', '..', '~'].includes(value) ||
		['/', './', '../', '~/'].some((prefix) => value.startsWith(prefix))
	);
}

/** A folder path as a person typed it, with `~` expanded, as an absolute path. */
export function resolveFolder(path: string): string {
	return resolve(
		path === '~'
			? homedir()
			: path.startsWith('~/')
				? join(homedir(), path.slice(2))
				: path,
	);
}

/** Load a folder outside the home, refusing alternate spellings of home apps. */
export async function loadFolder(
	path: string,
	words: string[],
): Promise<Result<Located, CliError>> {
	const folder = resolveFolder(path);
	const found = await entryAt(folder);
	if (!found)
		return CliError.Usage({
			message: `${path} must be a directory containing ${DECLARATION}`,
		});
	for (const entry of (await entries()).entries) {
		if (entry.realPath === found.realPath) {
			const next = ['epicenter', entry.entry, ...words].join(' ');
			return CliError.Usage({
				message: `${path} is the app ${entry.entry} in ${homeDir()}; run ${next}`,
				next,
			});
		}
	}
	return Ok(await load(found));
}
