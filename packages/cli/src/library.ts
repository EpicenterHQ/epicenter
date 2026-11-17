/**
 * The one `@epicenter/app` a home runs. A home is a Bun workspace that
 * depends on `@epicenter/cli` and `@epicenter/app`, so this command and every
 * app's `epicenter.ts` find the library by ordinary resolution, in the
 * `node_modules/` at the top of the home. An action reaches its app's folder
 * through state the library keeps per call (`packages/app/src/context.ts`),
 * which works only when the command that starts the call and the app that
 * runs it loaded the same copy.
 */
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The package folder of a resolved `@epicenter/app` entry, `src/index.ts`, with links followed. */
const packageFolder = (entry: string) => dirname(dirname(realpathSync(entry)));

/** The folder of the `@epicenter/app` this command runs. */
export const LIBRARY = packageFolder(
	Bun.fileURLToPath(import.meta.resolve('@epicenter/app')),
);

const NEXT = 'run bun install at the top of the home';

/**
 * Why the app `app`, whose code is really in `codePath`, does not share
 * this command's `@epicenter/app`, or undefined when it does. Bun resolves a
 * package from where a file really is, so an entry that is a link to code
 * outside the home (`link`, its target) looks for packages there, not in the
 * home.
 */
export function libraryProblem(
	app: string,
	codePath: string,
	link?: string,
): string | undefined {
	let found: string;
	try {
		found = packageFolder(Bun.resolveSync('@epicenter/app', codePath));
	} catch {
		return link
			? `apps/${app} is a link to ${link}, where no @epicenter/app is found: code finds packages from where it is, not from this home. Keep the app's code inside this home`
			: `apps/${app} finds no @epicenter/app; ${NEXT}`;
	}
	if (found === LIBRARY) return undefined;
	return `apps/${app} resolves @epicenter/app at ${found}, and epicenter runs ${LIBRARY}; ${NEXT}`;
}

/**
 * The version of Epicenter the home at `folder` runs: what its
 * `node_modules/@epicenter/cli` says it is, or null when the home has no
 * install.
 */
export async function installedVersion(folder: string): Promise<string | null> {
	try {
		const manifest: unknown = await Bun.file(
			join(folder, 'node_modules', '@epicenter', 'cli', 'package.json'),
		).json();
		const version = (manifest as { version?: unknown } | null)?.version;
		return typeof version === 'string' ? version : null;
	} catch {
		return null;
	}
}
