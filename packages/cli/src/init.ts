/** `epicenter init` writes the marker, `EPICENTER.md`, and adds starter guidance (ADR-0868). */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { BAD_PORT, misuse, parseWords, portOf } from './commands.ts';
import { CliError } from './errors.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import {
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
This folder is an Epicenter. Each folder in it with an \`epicenter.ts\` is an
app. Run \`epicenter\` here to list them.
`;

const STARTER_AGENTS = `This folder is an Epicenter.
Each child folder with an epicenter.ts is an app and its own Git repository.

Prefer \`epicenter <app> <verb>\` to change an app's data: it checks each value
against the app's fields and commits each call's files into the app's history,
named for the call. \`epicenter <app>\` lists the verbs. \`set\` changes fields;
\`edit --old <text> --new <text>\` changes one passage of a file's body, and is
refused if that passage changed since you read it.

You may edit an app's files with your own tools instead. When you finish, say
what you did: \`epicenter sync <app> -m "<what you did>"\` commits what is
pending under that message and backs it up. A plain \`git commit\` in the app's
folder is safe too. Otherwise \`epicenter serve\` commits it within 5 minutes as
"changed outside epicenter".

\`epicenter history <app>\` lists what changed, newest first. \`epicenter undo
<app>\` reverts the most recent change as a new commit; run it again to go
further back, or name a commit from history to undo that one.

Files named *.local or *.local.* stay on this computer: each app's .gitignore
ignores them, and epicenter refuses to snapshot one that is not ignored.
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
	const given = parseWords(words, { port: { type: 'string' } }, [0, 1]);
	if (!given) return fail(misuse('init'), json);
	const [path] = given.positionals;
	const port =
		given.values.port === undefined
			? DEFAULT_PORT
			: portOf(given.values.port);
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
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, MARKER), marker(port), {
		flag: 'wx',
	});
	if (!existsSync(join(folder, 'AGENTS.md')))
		await writeFile(join(folder, 'AGENTS.md'), STARTER_AGENTS, { flag: 'wx' });
	if (json) writeJson({ folder, port });
	else {
		writeOut(`Made Epicenter at ${folder}.`);
		const hasApps = (await readdir(folder, { withFileTypes: true })).some(
			(entry) =>
				entry.isDirectory() &&
				existsSync(join(folder, entry.name, 'epicenter.ts')),
		);
		writeErr(hasApps ? 'Run: epicenter' : 'Run: epicenter new <name>');
	}
	return 0;
}
