/**
 * `epicenter init` writes the marker, `EPICENTER.md`, adds starter guidance
 * (ADR-0868), and makes the folder the Epicenter's own repository, its apps
 * in `apps/` (ADR-0884, ADR-0885).
 * `epicenter init --from <url>` instead rebuilds an Epicenter from that
 * repository and the repositories it lists.
 */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { BAD_PORT, misuse, parseWords, portOf } from './commands.ts';
import {
	restoreEpicenter,
	startEpicenterRepository,
} from './epicenter-repository.ts';
import { CliError } from './errors.ts';
import { identityProblem } from './git.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import {
	APPS,
	ancestorWithMarker,
	DEFAULT_PORT,
	folderPath,
	isMarked,
	MARKER,
} from './root.ts';

/** The marker for an Epicenter served on `port`: a note for people, its port in the front matter. */
const marker = (port: number) => `---
port: ${port}
---
This folder is an Epicenter. Each folder in its \`apps/\` with an
\`epicenter.ts\` is an app. Run \`epicenter\` here to list them.
`;

const STARTER_AGENTS = `This folder is an Epicenter.
Each folder in apps/ with an epicenter.ts is an app. An app is two Git
repositories: its folder holds its code (epicenter.ts, ui/, README.md), and
data/ inside it holds its data, a repository of its own that the code's
.gitignore leaves out.

An app is one Bun project: its package.json names everything epicenter.ts and
ui/ import, except @epicenter/app, which epicenter supplies. After \`bun add\`,
run \`epicenter install <app>\`. An app runs as it sits on disk: an action uses
the epicenter.ts that is there, and a UI in ui/ rebuilds within about a second
of a change to its files, committed or not. An action may read any file in
this Epicenter, another app's records included (\`../tasks/data/tasks/...\`);
change another app's data only through that app's actions.

Prefer \`epicenter <app> <verb>\` to change an app's data: it checks each value
against the app's fields and commits each call's files into the app's data
history, named for the call. \`epicenter <app>\` lists the verbs. \`set\` changes
fields; \`edit --old <text> --new <text>\` changes one passage of a file's body,
and is refused if that passage changed since you read it. An action writes only
under data/.

You may edit an app's files with your own tools instead: its code, or its data.
When you finish, say what you did: \`epicenter sync <app> -m "<what you did>"\`
commits what is pending in both repositories under that message and backs each
up to its own origin. A plain \`git commit\` in the app's folder or in its data/
is safe too; commit code with its own message before \`sync -m\`, which gives
both repositories the same one. Otherwise \`epicenter serve\` commits it within 5 minutes as
"changed outside epicenter". A code commit's message describes the code, never
a record: the code may be shared, and the data never is.

When you change a field, change the code first, then the data that no longer
fits, with an action or by hand; each data commit names the code it was written
under. A file whose front matter no field declares, or that lacks an optional
field, reads without any problem, so check the data yourself.

\`epicenter history <app>\` lists what changed in the code and the data, newest
first. \`epicenter undo <app>\` reverts the most recent data change as a new
commit; run it again to go further back, or name a commit from history to undo
that one. Code is reverted with \`git -C apps/<app> revert <commit>\`.

Files named *.local or *.local.* stay on this computer and live under data/:
data/.gitignore ignores them, and epicenter refuses to snapshot one that is not
ignored. Never run \`git clean -ffdx\` in an app's folder: it deletes data/.

This folder is a Git repository too, backed up on the same clock: it keeps
what is not in apps/, such as this file and folders that are not apps. Its
.gitignore leaves apps/ out, and repositories.json lists every repository in
apps/ with its origin; epicenter rewrites that list, so do not edit it. A
repository anywhere else in this folder stops the backup: move it into apps/.
\`epicenter init --from <this folder's origin>\` rebuilds this Epicenter on
another computer.
`;

function actualFolder(path: string): string {
	let existing = path;
	while (!existsSync(existing)) existing = dirname(existing);
	return resolve(realpathSync(existing), relative(existing, path));
}

/** Make a new Epicenter without nesting it inside another. */
export async function initCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(
		words,
		{ port: { type: 'string' }, from: { type: 'string' } },
		[0, 1],
	);
	if (!given) return fail(misuse('init'), json);
	const [path] = given.positionals;
	const { from } = given.values;
	if (from !== undefined && given.values.port !== undefined)
		return fail(
			misuse('init', '--from takes the port from the restored EPICENTER.md'),
			json,
		);
	const port =
		given.values.port === undefined ? DEFAULT_PORT : portOf(given.values.port);
	if (port === undefined) return fail(misuse('init', BAD_PORT), json);
	const folder = actualFolder(folderPath(path ?? '.'));
	if (isMarked(folder))
		return fail(
			CliError.Usage({ message: `${folder} is already an Epicenter` }).error,
			json,
		);
	const parent = ancestorWithMarker(dirname(folder));
	if (parent)
		return fail(
			CliError.Usage({
				message: `${folder} is inside the Epicenter at ${parent}`,
			}).error,
			json,
		);
	if (from !== undefined) return restore(from, folder, json);
	// Before writing anything, so a fresh computer's first init can be run again.
	const nobody = await identityProblem({ configOnly: false });
	if (nobody) return fail(CliError.Usage({ message: nobody }).error, json);
	await mkdir(folder, { recursive: true });
	try {
		await writeFile(join(folder, MARKER), marker(port), { flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		// The folder is not marked, so a case-insensitive disk found another name.
		const taken = (await readdir(folder)).find(
			(name) => name.toLowerCase() === MARKER.toLowerCase(),
		);
		return fail(
			CliError.Usage({
				message: `${folder} holds ${taken ?? MARKER}, which this disk does not tell apart from ${MARKER}; rename it, then run init again`,
			}).error,
			json,
		);
	}
	const wrote = [MARKER];
	if (!existsSync(join(folder, 'AGENTS.md'))) {
		await writeFile(join(folder, 'AGENTS.md'), STARTER_AGENTS, { flag: 'wx' });
		wrote.push('AGENTS.md');
	}
	await startEpicenterRepository(folder, wrote);
	if (json) writeJson({ folder, port });
	else {
		writeOut(`Made Epicenter at ${folder}.`);
		const apps = join(folder, APPS);
		const hasApps = (
			await readdir(apps, { withFileTypes: true }).catch(() => [])
		).some(
			(entry) =>
				entry.isDirectory() &&
				existsSync(join(apps, entry.name, 'epicenter.ts')),
		);
		writeErr(hasApps ? 'Run: epicenter' : 'Run: epicenter new <name>');
	}
	return 0;
}

/**
 * `init --from <url>`: rebuild the Epicenter at `folder` from its repository
 * and every repository it lists. 0 when everything listed with an origin came
 * back, 1 when a clone or an install failed, 2 when nothing ran.
 */
async function restore(url: string, folder: string, json: boolean) {
	let restored: Awaited<ReturnType<typeof restoreEpicenter>>;
	try {
		restored = await restoreEpicenter(url, folder);
	} catch (error) {
		return fail(
			CliError.Usage({ message: extractErrorMessage(error) }).error,
			json,
		);
	}
	if (json) writeJson(restored);
	else {
		writeOut(
			`Restored the Epicenter at ${folder}: cloned ${restored.cloned.length} ${restored.cloned.length === 1 ? 'repository' : 'repositories'}.`,
		);
		for (const path of restored.unbacked)
			writeErr(`${path} had no origin, so it was not restored.`);
		for (const { path, message } of restored.failed)
			writeErr(`${path}: ${message}`);
		writeErr(
			'Files named *.local stay on the computer that made them: connect again any an app needs, such as a sign-in.',
		);
	}
	return restored.failed.length > 0 ? 1 : 0;
}
