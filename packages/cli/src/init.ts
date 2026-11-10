/** `epicenter init` writes a root identity once and adds starter guidance. */
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { CliError } from './errors.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import {
	ancestorWithMarker,
	DEFAULT_PORT,
	folderPath,
	ROOT_MARKER,
} from './root.ts';

const STARTER_AGENTS = `This folder is an Epicenter.
Each child folder with an epicenter.ts is an app and its own Git repository.

Prefer \`epicenter <app> <verb>\` to change an app's data: it checks each value
against the app's fields and snapshots each write into the app's history.
\`epicenter <app>\` lists the verbs. \`set\` changes fields; \`edit --old <text>
--new <text>\` changes one passage of a file's body, and is refused if that
passage changed since you read it. You may edit the files with your own tools
instead; then run \`epicenter sync <app>\` to commit them.

\`epicenter history <app>\` lists what changed, newest first. \`epicenter undo
<app>\` reverts the most recent change as a new commit; run it again to go
further back, or name a commit from history to undo that one.

Files named *.local or *.local.* are never committed.
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
	let path: string | undefined;
	let port: number | undefined;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word === '--port' && port === undefined) {
			const value = words[++i];
			port = Number(value);
			if (
				value === undefined ||
				!Number.isInteger(port) ||
				port < 0 ||
				port > 65535
			)
				return fail(
					CliError.Usage({ message: 'Port must be an integer from 0 to 65535' })
						.error,
					json,
				);
		} else if (word?.startsWith('-') || path !== undefined)
			return fail(
				CliError.Usage({
					message: 'epicenter init takes one folder and maybe --port <n>',
				}).error,
				json,
			);
		else path = word;
	}
	const folder = actualFolder(folderPath(path ?? '.'));
	if (existsSync(join(folder, ROOT_MARKER)))
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
	const id = randomUUID();
	await writeFile(
		join(folder, ROOT_MARKER),
		`${JSON.stringify({ id, ...(port === undefined ? {} : { port }) }, null, 2)}\n`,
		{ flag: 'wx' },
	);
	if (!existsSync(join(folder, 'AGENTS.md')))
		await writeFile(join(folder, 'AGENTS.md'), STARTER_AGENTS, { flag: 'wx' });
	if (json) writeJson({ folder, id, port: port ?? DEFAULT_PORT });
	else {
		writeOut(`Made Epicenter at ${folder}.`);
		const hasApps = (await readdir(folder, { withFileTypes: true })).some(
			(entry) =>
				entry.isDirectory() && existsSync(join(folder, entry.name, 'epicenter.ts')),
		);
		writeErr(hasApps ? 'Run: epicenter' : 'Run: epicenter new <name>');
	}
	return 0;
}
