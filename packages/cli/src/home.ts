/**
 * The app home and folders run by path (ADR-0841, ADR-0857). A folder is an
 * app when it has an `epicenter.json`; its `epicenter.ts`, when present, adds
 * code. Each entry loads on its own so a broken app is listed without stopping
 * the others. Refusals carry the next command as data (ADR-0842).
 */
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
import {
	type Action,
	type CodeCollection,
	type Declaration,
	isName,
	problemsOf,
} from '@epicenter/app';

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
			/** Things worth knowing that do not stop a run, such as stale editor types. */
			notes: string[];
	  })
	| (Place & {
			ok: false;
			/** The entry's name, for the listing. */
			name: string;
			/** A valid name `epicenter.json` declares, so two entries declaring one name are both reported. */
			declaredName?: string;
			problems: string[];
	  });

/** An app that can run. */
export type Runnable = Extract<Located, { ok: true }>;

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

/** `~/Epicenter`: the only list of apps (ADR-0849). Tests move it by setting `HOME`. */
export function homeDir(): string {
	return join(homedir(), 'Epicenter');
}

const DECLARATION = 'epicenter.json';
const CODE = 'epicenter.ts';

/** The sibling TypeScript reads `epicenter.json`'s import through, with its literal types (ADR-0857). */
const GENERATED_TYPES = 'epicenter.d.json.ts';

/** The text of `epicenter.d.json.ts` for a declaration: its JSON, as a type. */
function declarationTypes(declaration: unknown): string {
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
	{ code, ...place }: NonNullable<Awaited<ReturnType<typeof entryAt>>>,
	entry?: string,
): Promise<Located> {
	const at = { ...place, entry };
	const broken = (problems: string[], declaredName?: string): Located => ({
		...at,
		ok: false,
		name: entry ?? '',
		...(declaredName ? { declaredName } : {}),
		problems,
	});
	let declaration: unknown;
	try {
		declaration = JSON.parse(
			await readFile(join(place.realPath, DECLARATION), 'utf8'),
		);
	} catch (error) {
		return broken([
			(error as NodeJS.ErrnoException).code === 'ENOENT'
				? `has ${CODE} but no ${DECLARATION}`
				: `${DECLARATION} is not JSON: ${message(error)}`,
		]);
	}
	const name = (declaration as { name?: unknown } | null)?.name;
	const declaredName = isName(name) ? name : undefined;
	// An invalid declaration is reported before any of the app's code runs.
	const declared = problemsOf(declaration);
	if (declared.length) return broken(declared, declaredName);
	let module: { default?: unknown } | undefined;
	if (code) {
		try {
			module = await import(pathToFileURL(join(place.realPath, CODE)).href);
		} catch (error) {
			return broken(
				[`importing ${CODE} threw: ${message(error)}`],
				declaredName,
			);
		}
	}
	const problems = problemsOf(declaration, module && (module.default ?? null));
	if (entry !== undefined && name !== entry)
		problems.push(`declares the name "${name}" but its folder is "${entry}"`);
	if (problems.length) return broken(problems, declaredName);
	const app = module?.default as
		| {
				collections: Record<string, CodeCollection>;
				actions: Record<string, Action>;
		  }
		| undefined;
	return {
		...at,
		ok: true,
		name: name as string,
		declaration: declaration as Declaration,
		collections: app?.collections ?? {},
		actions: app?.actions ?? {},
		notes: code ? await typesNotes(place.realPath, declaration) : [],
	};
}

/** A note when `epicenter.d.json.ts` is missing or no longer matches `epicenter.json`; loading never writes it. */
async function typesNotes(dir: string, declaration: unknown) {
	const current = await readFile(join(dir, GENERATED_TYPES), 'utf8').catch(
		() => undefined,
	);
	if (current === declarationTypes(declaration)) return [];
	return [
		`${GENERATED_TYPES} is ${current === undefined ? 'missing' : 'stale'}; run epicenter types ${dir}`,
	];
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
	const declared = (located: Located) =>
		located.ok ? located.name : located.declaredName;
	const checked = loaded.map((located): Located => {
		const name = declared(located);
		const others = loaded.filter(
			(other) => other !== located && declared(other) === name,
		);
		if (!name || located.entry === name || !others.length) return located;
		const problem = `"${name}" is also declared by ${others.map((other) => other.entry).join(', ')}`;
		return located.ok
			? {
					...located,
					ok: false,
					name: located.entry ?? '',
					declaredName: name,
					problems: [problem],
				}
			: { ...located, problems: [...located.problems, problem] };
	});
	return {
		home: homeDir(),
		missing: found.missing,
		apps: checked.filter((located) => located.ok),
		problems: checked.filter((located) => !located.ok),
	};
}

/** The home listing keeps runnable apps separate from entries with problems. */
export type Discovery = Awaited<ReturnType<typeof discoverAll>>;

/** Load only the requested home entry so unrelated apps cannot affect a run. */
export async function loadHomeApp(name: string): Promise<Located> {
	if (!isName(name)) throw new Refusal(`Unknown app "${name}"`, 'epicenter');
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
): Promise<Located> {
	const folder = resolveFolder(path);
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
