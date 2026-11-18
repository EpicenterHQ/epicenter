/**
 * The one `@epicenter/app` a home runs. A home is a Bun workspace that
 * depends on `@epicenter/cli` and `@epicenter/app`, so this command and every
 * app's `epicenter.ts` find the library by ordinary resolution, in the
 * `node_modules/` at the top of the home. An action reaches its app's folder
 * through state the library keeps per call (`packages/app/src/context.ts`),
 * which works only when the command that starts the call and the app that
 * runs it loaded the same copy.
 *
 * The command names the library as a peer at its own exact version, so an
 * install gives a home one copy, the one its `package.json` asks for. That
 * copy can be another version when the home asks for one, and Bun only
 * warns; the two are released together, so the command refuses it here.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VERSION } from './engines.ts';

/** The package folder of a resolved `@epicenter/app` entry, `src/index.ts`, with links followed. */
const packageFolder = (entry: string) => dirname(dirname(realpathSync(entry)));

/** The folder of the `@epicenter/app` this command runs. */
export const LIBRARY = packageFolder(
	Bun.fileURLToPath(import.meta.resolve('@epicenter/app')),
);

/** The version of that `@epicenter/app`, which must be this command's own. */
const LIBRARY_VERSION: unknown = JSON.parse(
	readFileSync(join(LIBRARY, 'package.json'), 'utf8'),
).version;

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
): string | undefined {
	let found: string;
	try {
		found = packageFolder(Bun.resolveSync('@epicenter/app', codePath));
	} catch {
		return `apps/${app} finds no @epicenter/app from ${codePath}; ${NEXT}`;
	}
	if (found !== LIBRARY)
		return `apps/${app} resolves @epicenter/app at ${found}, and epicenter runs ${LIBRARY}; ${NEXT}`;
	if (LIBRARY_VERSION !== VERSION)
		return `apps/${app} would run @epicenter/app ${LIBRARY_VERSION} under epicenter ${VERSION}, and the two are released together; set @epicenter/cli and @epicenter/app to one version in the home's package.json, then ${NEXT}`;
	return undefined;
}
