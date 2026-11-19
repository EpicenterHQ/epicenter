/**
 * The apps in an Epicenter (ADR-0841), each a folder in its `apps/`, loaded
 * once (ADR-0959). Every folder there is an app, named by the folder's
 * name: its `code/epicenter.ts` default-exports `defineApp(...)`, or the
 * folder is listed with why it does not. A link in `apps/` is refused, not
 * followed, so an app's code and data are always inside the Epicenter.
 * Serve loads every entry when it starts and answers from what it loaded
 * until it stops. Each entry
 * loads inside its own guard, so a broken app is listed with its problems
 * and the others still load.
 */
import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractErrorMessage } from 'wellcrafted/error';
import packageJson from '../../package.json' with { type: 'json' };
import { objectSchema } from '../field.ts';
import {
	type App,
	defineApp,
	type Folder,
	folderOnDisk,
	isName,
} from '../index.ts';
import {
	type ActionTool,
	type AppListing,
	type AppProblems,
	type Listing,
	toolName,
} from './protocol.ts';
import { appDir, appPath, type EpicenterRoot, fromRoot } from './root.ts';

/** The words the `epicenter` command keeps for itself, which no app may be named. */
export const COMMAND_WORDS = ['serve'] as const;

/**
 * Why `name` cannot name an app, or `undefined` when it can: it must be
 * lowercase letters, digits, and dashes, starting with a letter, and not a
 * word the `epicenter` command keeps for itself.
 */
function nameProblem(name: string): string | undefined {
	if (!isName(name))
		return `${JSON.stringify(name)} is not lowercase letters, digits, and dashes, starting with a letter`;
	if ((COMMAND_WORDS as readonly string[]).includes(name))
		return `"${name}" is an epicenter command`;
	return undefined;
}

/**
 * One entry in `apps/` as it loaded: the app its code defines, if it
 * loaded, and every problem found. A loaded app can still have one: a
 * `local/` that could reach Git.
 */
export type AppEntry = {
	/** Its folder's name in `apps/`, which is the app's name. */
	name: string;
	/** The folder whose code and data the app uses. */
	folder: string;
	/** What the function `epicenter.ts` default-exports returned, when it loaded. */
	app?: App;
	problems: string[];
};

/** Every entry in `apps/`, by name, in name order. */
export type Apps = Map<string, AppEntry>;

const CODE = 'code/epicenter.ts';

/** What `epicenter.ts` in `folder` defines, or why it does not load. */
async function importApp(
	folder: string,
): Promise<{ app?: App; problems: string[] }> {
	const thrown = (error: unknown) => ({
		problems: extractErrorMessage(error)
			.split('\n')
			.map((line) => `${CODE}: ${line}`),
	});
	let module: { default?: unknown };
	try {
		module = await import(pathToFileURL(join(folder, CODE)).href);
	} catch (error) {
		return thrown(error);
	}
	const exported = module.default;
	if (typeof exported !== 'function')
		return { problems: [`${CODE} does not export defineApp(...) by default`] };
	try {
		// Through `defineApp` again, so the call checks what the export returns, however it was made.
		const app = defineApp(exported as (given: { folder: Folder }) => App)({
			folder: folderOnDisk(folder),
		});
		return { app, problems: [] };
	} catch (error) {
		return thrown(error);
	}
}

/**
 * Why the `local/` of the app `name` in `folder` could reach Git, or
 * undefined when it has no `local/` or the folder ignores itself
 * (ADR-0963). The fix is named, not made: the owner or an agent runs it.
 */
async function localProblem(
	name: string,
	folder: string,
): Promise<string | undefined> {
	const local = join(folder, 'local');
	if (!(await lstat(local).catch(() => undefined))?.isDirectory())
		return undefined;
	if (await lstat(join(local, '.gitignore')).catch(() => undefined))
		return undefined;
	const named = `${appDir(name)}/local`;
	return `${named} has no .gitignore; run: echo '*' > ${named}/.gitignore`;
}

/** The entry `name` in `apps/`, loaded; undefined when it is not a folder or a link. */
async function loadEntry(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
): Promise<AppEntry | undefined> {
	const folder = appPath(root, name);
	const listed = (problems: string[]) => ({ name, folder, problems });
	try {
		const entry = await lstat(folder);
		if (entry.isSymbolicLink())
			return listed([
				`${appDir(name)} is a link; an app is a folder in apps/, not a link to one`,
			]);
		if (!entry.isDirectory()) return undefined;
		if (!(await stat(join(folder, CODE)).catch(() => undefined))?.isFile())
			return listed([`no ${CODE}`]);
		const named = nameProblem(name);
		const loaded = named
			? { problems: [`its folder's name cannot name an app: ${named}`] }
			: await importApp(folder);
		const local = await localProblem(name, folder);
		return {
			name,
			folder,
			...loaded,
			problems: [
				...loaded.problems.map((problem) => fromRoot(root, problem)),
				...(local ? [local] : []),
			],
		};
	} catch (error) {
		return listed([fromRoot(root, extractErrorMessage(error))]);
	}
}

/**
 * Load every entry in `apps/`, each inside its own guard, so one broken app
 * does not stop the others; none when there is no `apps/`.
 */
export async function loadApps(
	root: Pick<EpicenterRoot, 'folder'>,
): Promise<Apps> {
	const names = (
		await readdir(join(root.folder, 'apps')).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return [] as string[];
				throw error;
			},
		)
	)
		.filter((name) => !name.startsWith('.'))
		.sort();
	const entries = await Promise.all(names.map((name) => loadEntry(root, name)));
	return new Map(
		entries
			.filter((entry) => entry !== undefined)
			.map((entry) => [entry.name, entry]),
	);
}

/** The app `name` as the listing carries it. */
export function appListing(name: string, app: App): AppListing {
	return {
		name,
		description: app.description,
		...(app.data
			? {
					data: Object.fromEntries(
						Object.entries(app.data).map(([key, handle]) => [
							key,
							{
								path: `data/${key}/`,
								description: handle.description,
								fields: objectSchema(handle.fields),
							},
						]),
					),
				}
			: {}),
		actions: Object.entries(app.actions).map(
			([action, defined]): ActionTool => ({
				name: toolName(name, action),
				description: defined.description,
				inputSchema: defined.input,
				...(defined.annotations ? { annotations: defined.annotations } : {}),
				...(defined.mcp === false ? { mcp: false as const } : {}),
			}),
		),
	};
}

/** The listing of `apps` as serve loaded them, without the routines. */
export function listApps(apps: Apps): Omit<Listing, 'routines'> {
	const entries = [...apps.values()];
	return {
		version: packageJson.version,
		apps: entries.flatMap(({ name, app }) =>
			app ? [appListing(name, app)] : [],
		),
		problems: entries.flatMap(({ name, problems }): AppProblems[] =>
			problems.length ? [{ entry: name, problems }] : [],
		),
	};
}
