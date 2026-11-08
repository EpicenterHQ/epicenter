/**
 * The app home and folders run by path (ADR-0841). Each entry loads on its own
 * so a broken app is listed without stopping the others. Refusals carry the
 * next command as data, as the error contract requires (ADR-0842).
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Action, type App, problemsOf } from '@epicenter/app';
import { cacheRoot } from './disk.ts';
import { keychainService } from './secrets.ts';

/** An app's disk identity, loaded definition, and problems that prevent a run. */
export type Located = {
	/** The folder or link name in the home; absent for a folder run by path. */
	entry?: string;
	/** The app's declared name when valid, otherwise its entry name or empty. */
	name: string;
	/** The home entry's path, or the explicit folder path, before resolving links. */
	folder: string;
	/** The real directory whose epicenter.ts and data the runner uses. */
	realPath: string;
	/** The real target when the entry itself is a symlink, for the listing. */
	link?: string;
	/** This copy's cache directory, separate for a folder run by path. */
	cacheDir: string;
	/** The Keychain service shared by local copies of the declared app. */
	keychain: string;
	/** The definition when problemsOf accepts it; a name mismatch still blocks it. */
	app?: App<Record<string, Action>>;
	/** A syntactically valid declared name, even when other app problems exist. */
	declaredName?: string;
	/** The reasons this entry cannot run; empty for a healthy app. */
	problems: string[];
};

/** A refusal before an action starts, with the command that resolves it when known. */
export class Refusal extends Error {
	/** Keep the next command separate from the message so callers need not parse prose. */
	constructor(
		message: string,
		readonly next?: string,
	) {
		super(message);
	}
}

/** Locate the app home without depending on the current working directory. */
export function homeDir(): string {
	return resolve(process.env.EPICENTER_HOME ?? join(homedir(), 'Epicenter'));
}

async function entryAt(folder: string) {
	try {
		const info = await lstat(folder);
		if (!info.isDirectory() && !info.isSymbolicLink()) return undefined;
		if (!(await stat(folder)).isDirectory()) return undefined;
		const realPath = await realpath(folder);
		if (!(await stat(join(realPath, 'epicenter.ts'))).isFile())
			return undefined;
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

async function load(
	found: NonNullable<Awaited<ReturnType<typeof entryAt>>>,
	entry?: string,
): Promise<Located> {
	const located: Located = {
		...found,
		entry,
		name: entry ?? '',
		cacheDir: '',
		keychain: '',
		problems: [],
	};
	try {
		const module = await import(
			pathToFileURL(join(found.realPath, 'epicenter.ts')).href
		);
		located.problems = problemsOf(module.default);
		const name = module.default?.name;
		if (typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name))
			located.declaredName = name;
		if (located.problems.length === 0) {
			located.app = module.default;
			located.name = name;
			if (entry !== undefined && name !== entry)
				located.problems.push(
					`declares the name "${name}" but its folder is "${entry}"`,
				);
		}
	} catch (error) {
		located.problems.push(
			`importing epicenter.ts threw: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const suffix =
		entry === undefined
			? `-${createHash('sha256').update(found.realPath).digest('hex').slice(0, 12)}`
			: '';
	located.cacheDir = join(cacheRoot(), `${located.name}${suffix}`);
	located.keychain = keychainService(located.name);
	return located;
}

/** Import every home entry independently so one broken app does not hide the rest. */
export async function discoverAll() {
	const found = await entries();
	const loaded = await Promise.all(
		found.entries.map((entry) => load(entry, entry.entry)),
	);
	for (const located of loaded) {
		const name = located.declaredName;
		if (!name || located.entry === name) continue;
		const others = loaded.filter(
			(other) => other !== located && other.declaredName === name,
		);
		if (others.length)
			located.problems.push(
				`"${name}" is also declared by ${others.map((other) => other.entry).join(', ')}`,
			);
	}
	return {
		home: homeDir(),
		missing: found.missing,
		apps: loaded.filter((app) => app.problems.length === 0),
		problems: loaded.filter((app) => app.problems.length > 0),
	};
}

/** The home listing keeps runnable apps separate from entries with problems. */
export type Discovery = Awaited<ReturnType<typeof discoverAll>>;

/** Load only the requested home entry so unrelated apps cannot affect a run. */
export async function loadHomeApp(name: string): Promise<Located> {
	if (!/^[a-z][a-z0-9-]*$/.test(name))
		throw new Refusal(`Unknown app "${name}"`, 'epicenter');
	const found = await entryAt(join(homeDir(), name));
	if (found) return load(found, name);
	try {
		await stat(homeDir());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			throw new Refusal(
				`Unknown app "${name}". There is no Epicenter home at ${homeDir()}. Make one with: mkdir ${process.env.EPICENTER_HOME ? homeDir() : '~/Epicenter'}`,
				`mkdir ${process.env.EPICENTER_HOME ? homeDir() : '~/Epicenter'}`,
			);
		throw error;
	}
	throw new Refusal(`Unknown app "${name}"`, 'epicenter');
}

/** Recognize explicit folder spellings while leaving app names unambiguous. */
export function isFolderPath(value: string): boolean {
	return (
		['.', '..', '~'].includes(value) ||
		['/', './', '../', '~/'].some((prefix) => value.startsWith(prefix))
	);
}

/** Load a folder outside the home, refusing alternate spellings of home apps. */
export async function loadFolder(
	path: string,
	words: string[],
): Promise<Located> {
	const folder = resolve(
		path === '~'
			? homedir()
			: path.startsWith('~/')
				? join(homedir(), path.slice(2))
				: path,
	);
	const found = await entryAt(folder);
	if (!found)
		throw new Error(`${path} must be a directory containing epicenter.ts`);
	for (const entry of (await entries()).entries) {
		if (entry.realPath === found.realPath) {
			const next = ['epicenter', entry.entry, ...words].join(' ');
			throw new Refusal(
				`${path} is the app ${entry.entry} in ${homeDir()}; run ${next}`,
				next,
			);
		}
	}
	return load(found);
}
