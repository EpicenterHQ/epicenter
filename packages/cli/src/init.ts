/** Initialize one root repository and Bun workspace, with apps in code/data containers. */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { ActionError, type Answer, Err, Ok } from '@epicenter/app';
import { parseWords } from './commands.ts';
import { VERSION } from './engines.ts';
import { checkedGit, git, isRepositoryTop } from './git.ts';
import { installHome, installNext } from './install.ts';
import { writeErr } from './output.ts';
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

/**
 * What makes a home one Bun workspace that runs this version of Epicenter:
 * `bun install` at its top installs the command and the library every app
 * imports, once, and takes each app's code as a package, and `bun run build`
 * there runs every app's own `build`. An owner adds a package nested inside
 * an app to `workspaces` by hand.
 */
const HOME_PACKAGE = `${JSON.stringify(
	{
		private: true,
		workspaces: ['apps/*/code'],
		scripts: { build: "bun run --filter '*' --if-present build" },
		dependencies: { '@epicenter/cli': VERSION, '@epicenter/app': VERSION },
	},
	null,
	2,
)}\n`;

/** The routine a new home commits itself with: the script, every five minutes. */
const CHECKPOINT_ROUTINE = `---
cron: "*/5 * * * *"
run: ["sh", "scripts/checkpoint.sh"]
---
Commit everything pending and push to the backup.
`;

/**
 * What that routine runs, from the home. It is the home's own file: Git
 * stores the home, and \`epicenter\` has no command that commits.
 */
const CHECKPOINT_SCRIPT = `#!/bin/sh
set -eu
for s in MERGE_HEAD REVERT_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD; do
  [ -e ".git/$s" ] && { echo "merge or rebase underway" >&2; exit 0; }
done
git add -A
if git ls-files -s | grep -q '^160000'; then
  echo "a nested Git repository is staged; remove its .git" >&2; exit 1
fi
git diff --cached --quiet || git commit -qm "\${1:-checkpoint}"
git remote get-url origin >/dev/null 2>&1 || exit 0
GIT_TERMINAL_PROMPT=0 git push -q origin HEAD
`;

const indented = (text: string) =>
	text
		.trimEnd()
		.split('\n')
		.map((line) => `    ${line}`)
		.join('\n');

const STARTER_AGENTS = `This folder is an Epicenter: one private Git repository holding every app's
code and records. Each folder in apps/ is an app:

  apps/<app>/code/   the app: epicenter.ts, package.json, ui/, README.md
  apps/<app>/data/   its records and settings
  apps/<app>/local/  what stays on this computer: tokens, caches, databases

This folder is one Bun workspace. Its package.json names the version of
Epicenter it runs, as the dependencies @epicenter/cli and @epicenter/app, and
takes each apps/<app>/code as a package. Run \`bun install\` here, at the top.
It writes one bun.lock, which is committed, and one node_modules/, which is
not. After \`git clone\`, \`bun install\` then \`bun run build\` is all a restore needs. The version of Epicenter
is the one in package.json. To upgrade, edit both versions there, then run
\`bun install && bun run build\`, which rebuilds every app's UI against the new
client. Restart serve after changing packages, by stopping it and starting it again: serve keeps the
packages it has loaded. An edit to an app's own files shows on the next call.

An app's code/package.json is named for the app and names everything
epicenter.ts and ui/ import, except @epicenter/app, which comes from the top
package.json. Add a package with \`bun add <package>\` in code/. A package
nested inside an app, such as apps/films/code/render/ with its own
package.json, gets its packages only once you add its path to the top
package.json by hand:
  "workspaces": ["apps/*/code", "apps/films/code/render"]

Never put records in code/. An action writes only under data/ and local/, and names a file by its
path from the app's folder, such as data/tasks/<time>.md or local/google.md.
local/ appears when an action first writes there.

A browser UI is optional. Keep everything it uses in code/, its palette too:
an app owns its own copy of its colors, so copy theme.css from a sibling app
rather than linking one outside code/. A link leading out of code/ breaks
when the app is copied or shared.

Change records with \`epicenter <app> <action>\` when an action fits;
\`epicenter <app>\` lists them. You may also edit code and records directly.
Apps run from the files on disk: the next call uses the code/epicenter.ts
there. A UI is what the app's own build writes to code/ui/dist/, and serve
serves only that: after changing code/ui/, run \`bun run build\` in code/.
A record that no longer fits the code still reads,
with its problems listed: when you change a field, change the code, then
repair the records that no longer fit.

Epicenter runs actions and serves pages. Git stores this folder, and
Epicenter does not wrap Git: actions make no commits, and no epicenter
command commits or pushes. This folder commits itself with two files of its
own, which you may change. routines/checkpoint.md runs every five minutes
while \`epicenter serve\` is running:

${indented(CHECKPOINT_ROUTINE)}

It runs scripts/checkpoint.sh:

${indented(CHECKPOINT_SCRIPT)}

The script commits everything pending as one commit named "checkpoint", and
pushes when there is an origin. It waits out a merge, rebase, revert or
cherry-pick. It refuses while a Git repository is nested in this folder,
because the commit would hold only a pointer to it and not its files.
Two runs need no lock: Git refuses a second commit while one is being made,
and a push still running when the next run starts costs an error line. Remove the routine file and nothing is committed or
pushed on its own.

Run \`epicenter\` to see each routine, how long ago the last commit was, how
many files are uncommitted, and how many commits are not on origin.

The branch and the index are shared: the script commits whatever is staged
along with everything else. Make a named commit with git before a risky
change. Keep origin private: it receives every app's records.

Do experiments outside this folder. Branches, checkouts, stashes, resets, and
rebases here change the live code and records of every running app.

To recover, inspect, then restore selected paths:
  git log --oneline -- apps/<app>/
  git restore --source=<commit> -- apps/<app>/code/    the code only
  git restore --source=<commit> -- apps/<app>/data/    the records only
Restoring apps/<app>/ whole reverts both and deletes files newer than that
commit.

An app is code/, data/ and local/. What is in apps/<app>/local/ stays on this
computer: the line /apps/*/local/ in .gitignore keeps it out of every commit,
whoever makes the folder. Git's ignore rules are the only guard: keep that
line, and never \`git add -f\` a file there. Never run git clean -x here: it
deletes what Git ignores.
`;

function actualFolder(path: string): string {
	let existing = path;
	while (!existsSync(existing)) existing = dirname(existing);
	return resolve(realpathSync(existing), relative(existing, path));
}

/**
 * Make a new Epicenter without nesting it inside another. A home made whose
 * packages did not install answers `Problems`, its report the home it made
 * and the install as the next step: it ran, and installing again is the repair.
 */
export async function initCommand(
	words: string[],
	json: boolean,
): Promise<Answer> {
	const { data: given, error: misused } = parseWords(
		'init',
		words,
		{ port: { type: 'string' }, 'no-install': { type: 'boolean' } },
		[0, 1],
	);
	if (misused) return Err(misused);
	const [path] = given.positionals;
	const port = Number(given.values.port ?? DEFAULT_PORT);
	if (
		given.values.port !== undefined &&
		!(/^\d+$/.test(given.values.port) && port >= 1 && port <= 65535)
	)
		return ActionError.NotStarted({
			cause: 'usage',
			message: '--port must be a whole number from 1 to 65535',
			next: 'epicenter init --help',
		});
	const folder = actualFolder(folderPath(path ?? '.'));
	if (isMarked(folder))
		return ActionError.NotStarted({
			cause: 'usage',
			message: `${folder} is already an Epicenter`,
		});
	const parent = ancestorWithMarker(dirname(folder));
	if (parent)
		return ActionError.NotStarted({
			cause: 'usage',
			message: `${folder} is inside the Epicenter at ${parent}`,
		});
	await mkdir(folder, { recursive: true });
	// Establish Git identity before writing the marker, so a missing identity is retryable.
	if (!(await isRepositoryTop(folder)))
		await checkedGit(folder, ['init', '-q']);
	for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
		if ((await git(folder, ['var', identity])).code !== 0)
			return ActionError.NotStarted({
				cause: 'usage',
				message:
					'Git needs your name and email before creating an Epicenter. Set user.name and user.email in Git, then run init again.',
				next: 'git config --global user.name "Your name" and git config --global user.email "you@example.com"',
			});
	}
	try {
		await writeFile(join(folder, MARKER), marker(port), { flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		// The folder is not marked, so a case-insensitive disk found another name.
		const taken = (await readdir(folder)).find(
			(name) => name.toLowerCase() === MARKER.toLowerCase(),
		);
		return ActionError.NotStarted({
			cause: 'usage',
			message: `${folder} holds ${taken ?? MARKER}, which this disk does not tell apart from ${MARKER}; rename it, then run init again`,
		});
	}
	const wrote = [MARKER];
	if (!existsSync(join(folder, 'AGENTS.md'))) {
		await writeFile(join(folder, 'AGENTS.md'), STARTER_AGENTS, { flag: 'wx' });
		wrote.push('AGENTS.md');
	}
	for (const [path, text, mode] of [
		['package.json', HOME_PACKAGE, 0o644],
		['routines/checkpoint.md', CHECKPOINT_ROUTINE, 0o644],
		['scripts/checkpoint.sh', CHECKPOINT_SCRIPT, 0o755],
		// Bun would otherwise load the root's .env into every process it starts,
		// and a routine's child inherits it (ADR-0948).
		['bunfig.toml', 'env = false\n', 0o644],
	] as const) {
		await mkdir(dirname(join(folder, path)), { recursive: true });
		try {
			await writeFile(join(folder, path), text, { flag: 'wx', mode });
			wrote.push(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	}
	// Installed before the first commit, so that commit holds the lock.
	const hadLock = existsSync(join(folder, 'bun.lock'));
	const failed = given.values['no-install']
		? undefined
		: await installHome(folder);
	if (!hadLock && existsSync(join(folder, 'bun.lock'))) wrote.push('bun.lock');
	await startEpicenterRepository(folder, wrote);
	if (failed)
		// The home is made; only its packages are missing, and installing again is the repair.
		return ActionError.Problems({
			message: `Its packages did not install: ${failed.message}`,
			report: json ? { folder, port } : `Made Epicenter at ${folder}.`,
			next: failed.next,
		});
	if (json) return Ok({ folder, port });
	// The next steps are hints beside the answer, as stderr carries them today.
	if (given.values['no-install']) writeErr(`Run: ${installNext(folder)}`);
	const apps = join(folder, APPS);
	const hasApps = (
		await readdir(apps, { withFileTypes: true }).catch(() => [])
	).some(
		(entry) =>
			entry.isDirectory() &&
			existsSync(join(apps, entry.name, 'code', 'epicenter.ts')),
	);
	writeErr(hasApps ? 'Run: epicenter' : 'Run: epicenter new <name>');
	return Ok(`Made Epicenter at ${folder}.`);
}

/**
 * What the checkpoint routine must never stage: what an app keeps on this
 * computer, and credentials the owner pastes into .env (ADR-0948), while
 * .env.example, which names keys without values, stays committable.
 */
const PRIVATE_IGNORES = ['/apps/*/local/', '.env*', '!.env.example'];

/** Initialize the root and commit only files this invocation wrote. */
async function startEpicenterRepository(root: string, wrote: string[]) {
	if (!(await isRepositoryTop(root))) await checkedGit(root, ['init', '-q']);
	await mkdir(join(root, APPS), { recursive: true });
	const ignorePath = join(root, '.gitignore');
	if (!existsSync(ignorePath)) {
		await writeFile(
			ignorePath,
			`${PRIVATE_IGNORES.join('\n')}\nnode_modules/\n.DS_Store\n/apps/*/code/ui/dist/\n/apps/*/.code-build-*/\n`,
		);
		wrote.push('.gitignore');
	} else {
		// A .gitignore already here is kept, but the checkpoint routine init
		// installs would push what it fails to ignore, so the missing lines go
		// at its end, after any line that could undo them.
		const kept = await readFile(ignorePath, 'utf8');
		const present = new Set(kept.split('\n').map((line) => line.trim()));
		const missing = PRIVATE_IGNORES.filter((line) => !present.has(line));
		if (missing.length > 0) {
			const separator = kept === '' || kept.endsWith('\n') ? '' : '\n';
			await writeFile(ignorePath, `${kept}${separator}${missing.join('\n')}\n`);
			wrote.push('.gitignore');
			writeErr(`Added to .gitignore: ${missing.join(' ')}`);
		}
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
