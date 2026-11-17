/** Initialize or restore one root repository, with apps in code/data containers. */
import { existsSync, realpathSync } from 'node:fs';
import {
	mkdir,
	readdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import defaultTheme from '@epicenter/theme/theme.css' with { type: 'text' };
import { extractErrorMessage } from 'wellcrafted/error';
import { isRepositoryTop } from './checkpoint.ts';
import { BAD_PORT, misuse, parseWords, portOf } from './commands.ts';
import { CliError } from './errors.ts';
import { checkedGit, git, gitMessage } from './git.ts';
import { installApp } from './install.ts';
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
This folder is an Epicenter. Each folder in its \`apps/\` is an app: its code in \`code/\`, its records in \`data/\`. Run \`epicenter\` here to list them.
`;

const STARTER_AGENTS = `This folder is an Epicenter: one private Git repository holding every app's
code and records. Each folder in apps/ is an app:

  apps/<app>/code/   the app: epicenter.ts, package.json, ui/, README.md
  apps/<app>/data/   its records and settings

An app's code/ is one Bun project: its package.json names everything
epicenter.ts and ui/ import, except @epicenter/app, which epicenter supplies.
After \`bun add\` in code/, run \`epicenter install <app>\`. Never put records in
code/. An action writes only under data/, and names a record by its path from
the app's folder, such as data/tasks/<time>.md.

A browser UI is optional. It can use its own styles or import the home
palette from theme.css. Keep its components and layout in code/.

Change records with \`epicenter <app> <action>\` when an action fits;
\`epicenter <app>\` lists them. You may also edit code and records directly.
Apps run from the files on disk: the next call uses the code/epicenter.ts
there, and serve rebuilds code/ui/ when a page opens after its files change,
keeping the last good build until a new one succeeds; \`epicenter build <app>\`
shows a build's errors. A record that no longer fits the code still reads,
with its problems listed: when you change a field, change the code, then
repair the records that no longer fit.

Actions make no commits. History comes from checkpoints: \`epicenter
checkpoint\` commits everything pending as one commit and pushes to origin
when one is set; \`-m "<what changed>"\` names it. \`epicenter serve\` runs the
same checkpoint when it starts, every 5 minutes, and when it stops. The
branch and the index are shared: a checkpoint commits whatever is staged
along with everything else. Make a named commit before a risky change. Keep
origin private: it receives every app's records.

Do experiments outside this folder. Branches, checkouts, stashes, resets, and
rebases here change the live code and records of every running app.

To recover, inspect, then restore selected paths:
  git log --oneline -- apps/<app>/
  git restore --source=<commit> -- apps/<app>/code/    the code only
  git restore --source=<commit> -- apps/<app>/data/    the records only
Restoring apps/<app>/ whole reverts both and deletes files newer than that
commit. A commit made before an app's repositories were combined holds only
one of code/ or data/, so restoring apps/<app>/ from it deletes the other.

Files named *.local or *.local.* stay on this computer: .gitignore keeps them
out, and a checkpoint refuses one Git would commit. Never run git clean -x
here: it deletes them.
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
	await mkdir(folder, { recursive: true });
	// Establish Git identity before writing the marker, so a missing identity is retryable.
	if (!(await isRepositoryTop(folder)))
		await checkedGit(folder, ['init', '-q']);
	for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
		if ((await git(folder, ['var', identity])).code !== 0)
			return fail(
				CliError.Usage({
					message:
						'Git needs your name and email before creating an Epicenter. Set user.name and user.email in Git, then run init again.',
					next: 'git config --global user.name "Your name" and git config --global user.email "you@example.com"',
				}).error,
				json,
			);
	}
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
	try {
		await writeFile(join(folder, 'theme.css'), defaultTheme, { flag: 'wx' });
		wrote.push('theme.css');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
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
				existsSync(join(apps, entry.name, 'code', 'epicenter.ts')),
		);
		writeErr(
			hasApps
				? 'Run: epicenter'
				: 'Run: epicenter new writing --from EpicenterHQ/epicenter/examples/writing',
		);
	}
	return 0;
}

/** Restore one root repository and install each runnable app's code. */
async function restore(url: string, folder: string, json: boolean) {
	try {
		if (existsSync(folder) && (await readdir(folder)).length)
			throw new Error(`${folder} is not empty; restore into a new folder`);
		await mkdir(dirname(folder), { recursive: true });
		// Fetch LFS after checking the marker so failures keep a usable clone.
		await checkedGit(dirname(folder), [
			'-c',
			'filter.lfs.process=',
			'-c',
			'filter.lfs.smudge=',
			'-c',
			'filter.lfs.required=false',
			'clone',
			'-q',
			url,
			folder,
		]);
		if (!isMarked(folder))
			throw new Error(`${url} has no ${MARKER} at its top`);
		const tracked = await checkedGit(folder, ['ls-files', '-z']);
		const attributes = await git(
			folder,
			['check-attr', '-z', '--stdin', 'filter'],
			{ input: tracked },
		);
		if (attributes.code !== 0)
			throw new Error(gitMessage(['check-attr'], attributes));
		const fields = attributes.stdout.split('\0');
		const lfs: string[] = [];
		for (let i = 0; i + 2 < fields.length; i += 3)
			if (fields[i + 2] === 'lfs') lfs.push(fields[i]!);
		if (lfs.length) {
			let path = lfs[0]!;
			try {
				if ((await git(folder, ['lfs', 'version'])).code !== 0)
					throw new Error('git-lfs is required; install git-lfs');
				await checkedGit(folder, ['lfs', 'install', '--local']);
				// LFS uses pathspec magic internally when checking out downloaded files.
				const pulled = await git(folder, [
					'--no-literal-pathspecs',
					'lfs',
					'pull',
				]);
				let pointer: string | undefined;
				for (const candidate of lfs) {
					path = candidate;
					const file = join(folder, candidate);
					if (
						(await stat(file)).size < 1024 &&
						(await readFile(file, 'utf8')).startsWith(
							'version https://git-lfs.github.com/spec/v1\n',
						)
					) {
						pointer = candidate;
						break;
					}
				}
				path = pointer ?? lfs[0]!;
				if (pulled.code !== 0)
					throw new Error(gitMessage(['lfs', 'pull'], pulled));
				if (pointer) throw new Error('file is still a Git LFS pointer');
			} catch (error) {
				throw new Error(
					`${path}: ${extractErrorMessage(error)}\nRun: git -C ${folder} lfs pull`,
				);
			}
		}
		const installed: string[] = [];
		const failed: { path: string; message: string }[] = [];
		for (const entry of await readdir(join(folder, APPS), {
			withFileTypes: true,
		}).catch(() => [])) {
			if (entry.name.startsWith('.')) continue;
			const container = join(folder, APPS, entry.name);
			if (
				!(
					await stat(join(container, 'code/epicenter.ts')).catch(
						() => undefined,
					)
				)?.isFile()
			)
				continue;
			const codePath = await realpath(join(container, 'code'));
			const result = await installApp(codePath, entry.name);
			const path = `${APPS}/${entry.name}`;
			if ('error' in result)
				failed.push({ path, message: result.error.message });
			else installed.push(path);
		}
		if (json) writeJson({ folder, installed, failed });
		else {
			writeOut(`Restored the Epicenter at ${folder}.`);
			for (const failure of failed)
				writeErr(`${failure.path}: ${failure.message}`);
		}
		writeErr('Files named *.local must be recreated on this computer.');
		return failed.length ? 1 : 0;
	} catch (error) {
		return fail(
			CliError.Usage({ message: extractErrorMessage(error) }).error,
			json,
		);
	}
}

/** Initialize the root and commit only files this invocation wrote. */
async function startEpicenterRepository(root: string, wrote: string[]) {
	if (!(await isRepositoryTop(root))) await checkedGit(root, ['init', '-q']);
	await mkdir(join(root, APPS), { recursive: true });
	if (!existsSync(join(root, '.gitignore'))) {
		await writeFile(
			join(root, '.gitignore'),
			'*.local\n*.local.*\nnode_modules/\n.DS_Store\n/apps/*/code/ui/dist/\n/apps/*/.code-build-*/\n',
		);
		wrote.push('.gitignore');
	}
	if (!existsSync(join(root, '.gitattributes')) && Bun.which('git-lfs')) {
		await checkedGit(root, ['lfs', 'install', '--local']);
		await writeFile(
			join(root, '.gitattributes'),
			[
				'webm',
				'm4a',
				'wav',
				'mp3',
				'png',
				'jpg',
				'jpeg',
				'heic',
				'gif',
				'webp',
				'mp4',
				'mov',
				'pdf',
			]
				.map(
					(extension) => `*.${extension} filter=lfs diff=lfs merge=lfs -text\n`,
				)
				.join(''),
		);
		wrote.push('.gitattributes');
	}
	await checkedGit(root, ['add', '--', ...wrote]);
	await checkedGit(root, [
		'commit',
		'-q',
		'-m',
		'start the Epicenter',
		'--',
		...wrote,
	]);
}
