/**
 * The app home and folders run by path (ADR-0841, ADR-0857). A folder is an
 * app when it has an `epicenter.json`; its `epicenter.ts`, when present, adds
 * code. Each entry loads on its own so a broken app is listed without stopping
 * the others. Refusals carry the next command as data (ADR-0842).
 */
import { createHash } from 'node:crypto';
import {
	lstat,
	readdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as appPackage from '@epicenter/app';
import {
	type Action,
	type App,
	type Declaration,
	problemsOf,
} from '@epicenter/app';
import { plugin } from 'bun';
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
	/** The real directory whose declaration, code, and data the runner uses. */
	realPath: string;
	/** The real target when the entry itself is a symlink, for the listing. */
	link?: string;
	/** This copy's cache directory, separate for a folder run by path. */
	cacheDir: string;
	/** The Keychain service shared by local copies of the declared app. */
	keychain: string;
	/** The parsed `epicenter.json` when it fits the schema. */
	declaration?: Declaration;
	/** The app's code when problemsOf accepts it; empty actions for a folder with no `epicenter.ts`. */
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

/**
 * `epicenter` supplies `@epicenter/app` to every `epicenter.ts` it loads
 * (ADR-0857), so an app needs a `package.json` only for its own
 * dependencies, and every app shares the one copy the command checks fields
 * with. The compiled binary carries this module and serves it the same way.
 */
plugin({
	name: '@epicenter/app',
	setup(build) {
		build.module('@epicenter/app', () => ({
			exports: appPackage,
			loader: 'object',
		}));
	},
});

/**
 * `~/Epicenter`: the only list of apps (ADR-0849). Tests move it by setting
 * `HOME`, read here on each call because Bun's `homedir()` keeps the value
 * the process started with.
 */
export function homeDir(): string {
	return join(process.env.HOME || homedir(), 'Epicenter');
}

const DECLARATION = 'epicenter.json';
const CODE = 'epicenter.ts';

/** The sibling TypeScript reads `epicenter.json`'s import through, with its literal types (ADR-0857). */
export const GENERATED_TYPES = 'epicenter.d.json.ts';

/** The text of `epicenter.d.json.ts` for a declaration: its JSON, as a type. */
export function declarationTypes(declaration: unknown): string {
	return `// Written by epicenter from epicenter.json, so its import keeps literal types. Do not edit.
declare const declaration: ${JSON.stringify(declaration, null, '\t')};
export default declaration;
`;
}

/** Write `epicenter.d.json.ts` beside the declaration when its text differs. */
export async function writeDeclarationTypes(dir: string, declaration: unknown) {
	const path = join(dir, GENERATED_TYPES);
	const text = declarationTypes(declaration);
	const current = await readFile(path, 'utf8').catch(() => undefined);
	if (current !== text) await writeFile(path, text);
	return path;
}

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

async function load(
	{ code, ...found }: NonNullable<Awaited<ReturnType<typeof entryAt>>>,
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
	const finish = () => {
		const suffix =
			entry === undefined
				? `-${createHash('sha256').update(found.realPath).digest('hex').slice(0, 12)}`
				: '';
		located.cacheDir = join(cacheRoot(), `${located.name}${suffix}`);
		located.keychain = keychainService(located.name);
		return located;
	};
	let declaration: unknown;
	try {
		declaration = JSON.parse(
			await readFile(join(found.realPath, DECLARATION), 'utf8'),
		);
	} catch (error) {
		located.problems.push(
			(error as NodeJS.ErrnoException).code === 'ENOENT'
				? `has ${CODE} but no ${DECLARATION}`
				: `${DECLARATION} is not JSON: ${message(error)}`,
		);
		return finish();
	}
	const name = (declaration as { name?: unknown } | null)?.name;
	if (typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name))
		located.declaredName = name;
	let module: { default?: unknown } | undefined;
	if (code) {
		try {
			// Types first, so an editor sees the declaration as it is now even when the code is broken.
			if (problemsOf(declaration).length === 0)
				await writeDeclarationTypes(found.realPath, declaration);
			module = await import(pathToFileURL(join(found.realPath, CODE)).href);
		} catch (error) {
			located.problems.push(`importing ${CODE} threw: ${message(error)}`);
			return finish();
		}
	}
	located.problems = problemsOf(declaration, module?.default);
	if (located.problems.length) return finish();
	located.declaration = declaration as Declaration;
	located.app = (module?.default as
		| App<Record<string, Action>>
		| undefined) ?? {
		declaration: located.declaration,
		collections: {},
		actions: {},
	};
	located.name = name as string;
	if (entry !== undefined && name !== entry)
		located.problems.push(
			`declares the name "${name}" but its folder is "${entry}"`,
		);
	return finish();
}

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
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
				`Unknown app "${name}". There is no Epicenter home at ${homeDir()}. Make one with: mkdir ${homeDir()}`,
				`mkdir ${homeDir()}`,
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
		throw new Error(`${path} must be a directory containing ${DECLARATION}`);
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
