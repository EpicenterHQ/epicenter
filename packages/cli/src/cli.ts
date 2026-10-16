/**
 * The `epicenter` command line: parse, dispatch to a thin wrapper over a
 * shared package, and return the exit code (ADR-0556, ADR-0558).
 *
 * Every command takes `--json`, and only `--json` switches the output: one
 * JSON value on stdout, or NDJSON lines ending in one result for a long
 * command. Stderr is for people in both modes. Exit codes are ADR-0520's:
 * 0 done, 1 a finding a person acts on, 2 input the tool cannot use.
 */

import packageJson from '../package.json' with { type: 'json' };
import { adrPointer, COMMANDS } from './commands.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';
import {
	type CommandSpec,
	type Invocation,
	parseArgs,
	usageLine,
} from './parse.ts';

type Run = (
	invocation: Extract<Invocation, { kind: 'command' }>,
) => Promise<number>;

/**
 * The commands built so far. Each loads its package only when it runs, so
 * `--version` and `--help` start without the folder engine.
 */
const HANDLERS: Record<string, Run> = {
	check: async ({ positionals: [dir], json }) =>
		(await import('./folder-commands.ts')).check(dir as string, json),
	query: async ({ positionals: [dir, sql], json }) =>
		(await import('./folder-commands.ts')).query(dir as string, sql, json),
	generate: async ({ positionals: [dir], json }) =>
		(await import('./folder-commands.ts')).generate(dir as string, json),
	status: async ({ positionals: [dir], options, json }) =>
		history('status', dir as string, options, json),
	history: async ({ positionals: [dir], options, json }) =>
		history('history', dir as string, options, json),
	'save-version': async ({ positionals: [dir], options, json }) =>
		history('save-version', dir as string, options, json),
	sync: async ({ positionals: [dir], options, json, desktop }) =>
		history('sync', dir as string, options, json, desktop),
	clone: async ({ positionals: [source, dir], json, desktop }) =>
		(await import('./repository-commands.ts')).clone(
			source as string,
			dir,
			json,
			desktop,
		),
	repos: async ({ json, desktop }) =>
		(await import('./repository-commands.ts')).repos(json, desktop),
	'merge-driver': async ({ positionals, json }) => {
		const driver = await import('./merge-driver.ts');
		// Git's `%O %A %B %P`, or the folder to configure.
		const [first, ours, theirs, path] = positionals as [string, ...string[]];
		if (path !== undefined)
			return driver.mergeDriver(first, ours as string, theirs as string, path);
		if (ours === undefined) return driver.configureCommand(first, json);
		return fail('Usage: epicenter merge-driver <dir>', json);
	},
	'app list': async ({ options, json }) =>
		(await import('./app-commands.ts')).appList(options, json),
	'app install': async ({ positionals: [source], options, json }) =>
		(await import('./app-commands.ts')).appInstall(
			source as string,
			options,
			json,
		),
	'app update': async ({ positionals: [id], options, json }) =>
		(await import('./app-commands.ts')).appUpdate(id as string, options, json),
	'app remove': async ({ positionals: [id], json }) =>
		(await import('./app-commands.ts')).appRemove(id as string, json),
	'auth key': async ({ positionals: [action, connection], json }) => {
		const [{ authKey }, { keychain }] = await Promise.all([
			import('./ai-commands.ts'),
			import('./secrets.ts'),
		]);
		return authKey(action as string, connection as string, json, keychain());
	},
	send: async ({ desktop }) => {
		const [
			{ send },
			{ keychain },
			{ accountAccess, authContext, epicenterAccess },
		] = await Promise.all([
			import('./ai-commands.ts'),
			import('./secrets.ts'),
			import('./auth.ts'),
		]);
		const ctx = authContext();
		const grant = desktop ? 'desktop' : 'device';
		return send(
			keychain(),
			epicenterAccess(ctx, grant),
			accountAccess(ctx, grant),
		);
	},
	'auth login': async ({ options, json, desktop }) =>
		(await import('./auth-commands.ts')).authLogin(options, json, desktop),
	'auth logout': async ({ json, desktop }) =>
		(await import('./auth-commands.ts')).authLogout(json, desktop),
	'auth status': async ({ json }) =>
		(await import('./auth-commands.ts')).authStatusCommand(json),
	'auth token': async ({ options, json, desktop }) =>
		(await import('./auth-commands.ts')).authToken(options, json, desktop),
	'auth git-credential': async ({ positionals: [action], desktop }) =>
		(await import('./auth-commands.ts')).authGitCredential(
			action as string,
			desktop,
		),
	'install-command': async ({ options, json }) =>
		(await import('./install-command.ts')).installCommand({
			json,
			dryRun: options['dry-run'] === true,
			userOnly: options['user-only'] === true,
		}),
};

/**
 * Run a history command. When the shell ends this process (a page reloaded,
 * or its window closed), every `git` it started ends too, with the helpers
 * each started (ADR-0559), and a refresh it sent finishes first (ADR-0565).
 */
async function history(
	command: 'status' | 'history' | 'save-version' | 'sync',
	dir: string,
	options: Record<string, string | true>,
	json: boolean,
	desktop = false,
) {
	const [{ historyCommand }, { endGitCommands }, { refreshesSettled }] =
		await Promise.all([
			import('./history-commands.ts'),
			import('@epicenter/folder/bun'),
			import('./auth.ts'),
		]);
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
		process.once(signal, () => {
			endGitCommands();
			// A refresh this process sent finishes its keychain write first.
			void refreshesSettled().then(() =>
				process.exit(
					128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 1),
				),
			);
		});
	return historyCommand(command, dir, options, json, desktop);
}

/** What `epicenter <command> --help` adds below the usage line. */
const DETAILS: Record<string, string> = {
	check: `Prints one line per file that does not conform, compiler style, then a
summary. Exits 0 when every file conforms, 1 when one does not, and 2 when
the folder or its declaration cannot be used or a file cannot be read.
Never writes a file or runs the folder's code.`,
	query: `Without a statement, describes each table's columns and what they hold.
With one, runs that single read-only statement (SELECT, WITH, VALUES, or
EXPLAIN) over the files that conform and prints tab-separated rows. A file
that does not conform is left out of every table and named on stderr (in
"excluded" with --json); check says why. Exits 0 when it answers and 2 when
the folder, the declaration, or the statement cannot be used.`,
	'app install': `Clones the repository into Apps/<app-id>/, the id read from the
epicenter.app.json in --folder (the root by default), then builds it with
bun run build:installed. A commit nobody approved on this machine is not
built: the command prints it with its log and exits 1 until it runs again
with --approve. --json prints NDJSON progress lines and one result line.`,
	'app update': `Fetches the app's upstream, fast-forwards or rebases the commits made
here, and builds the result if it may run. A commit made on this machine runs
without asking; one fetched from elsewhere is printed with its log and diff
stat, and the command exits 1 until it runs again with --approve.`,
	'auth key': `Keeps an AI connection's endpoint and key in this computer's keychain,
under the connection's id, the stem of its row in so.epicenter/connections
(ADR-0557). set reads {"endpoint": "<url>", "key": "<key>"} as JSON on
stdin, never from the command line; an empty or missing key saves a keyless
endpoint. state prints the endpoint and whether a key is saved, never the
key. remove deletes the entry. Exits 0, or 2 when the id, the input, or the
keychain cannot be used.`,
	'auth login': `Signs this computer in with a device code: open the link it prints, check
the code, and choose which folders it may reach. The sign-in is kept in this
computer's keychain, and Git's global configuration gets this command as its
credential helper for the deployment's Git origin. --json prints NDJSON: the
code and link as {"device": {...}}, then {"signedIn": {...}} or {"error"}.`,
	'auth token': `Prints an access token for --resource, by default the deployment's API,
refreshing the sign-in when the cached token has under five minutes left. One
refresh runs at a time on this computer. Exits 2 when this computer is not
signed in or the sign-in has ended.`,
	'auth status': `Names who each sign-in on this computer belongs to: this computer's, from
epicenter auth login, and the Epicenter app's. Reads only the keychain.`,
	'auth logout': `Revokes this computer's sign-in at the server and deletes it from the
keychain. The Epicenter app's sign-in is separate; sign it out in its Settings.`,
	'auth git-credential': `Git runs this as its credential helper (gitcredentials(7)). get answers
the deployment's Git origin with a username, an access token as the password,
and password_expiry_utc; any other host gets no answer. store and erase do
nothing. Takes no --json.`,
	status: `Prints the folder's branch and head, the files changed since the last
version, and the remote with how far ahead and behind it is. Reads only: it
runs Git and writes nothing. With --json, one line in the history encoding
the desktop app reads. Exits 0, or 2 when the folder cannot be used or git
is not installed ({"error": "GitMissing"} with --json).`,
	clone: `Clones <namespace>/<name> from this deployment's Git origin, or any
other URL as given with your own Git credentials, into <dir>, by default
~/Epicenter/<name>, then makes the clone merge by file kind. It registers
this command as Git's credential helper for the deployment's Git origin.
Run epicenter repos to list the names. Exits 2 when it cannot clone.`,
	repos: `Lists the repositories of every namespace this sign-in may reach: the
personal namespace first, then each group by title, as <namespace>/<name>.
With --json, {"namespaces": [{"id", "title", "personal", "role",
"repositories": [{"id", "name", "url"}]}]}.`,
	sync: `Records the folder's edits as a version, fetches the remote branch, merges
it by each file's kind, and pushes, under the folder's history lock, so two
syncs or a sync and save-version never interleave. --to <namespace>/<name>
connects the folder to that repository on this deployment's Git origin:
the first sync creates it, and the folder's remote becomes
<git origin>/<namespace>/<name>.git. Changes both sides made to
one setting, field, body, or file are not written: the command exits 1 with
the conflicts and records the attempt under .git/epicenter. --resolve <file>
settles it with {"attempt": "<id>", "choices": {"<conflict id>": choice}},
where a choice is {"kind": "take", "side": "local" | "incoming"},
{"kind": "replace", "value": ...}, or {"kind": "remove"}; - reads it from
standard input. A later sync retires the attempt.`,
	'merge-driver': `Makes git merge, git pull, and any Git client merge the folder's files
by kind, with the merge Epicenter's saves and Sync use: rows by field,
kv.json by key, other text by line. It writes "* merge=epicenter" to the
repository's .git/info/attributes and the driver, this binary by its path,
to its .git/config; nothing is committed. Git then runs epicenter
merge-driver -- <base> <ours> <theirs> <path> for each file both sides
changed. Units both sides changed differently get Git's conflict markers,
and git merge stops for a person as usual. A file in no data folder, or
that is not text, merges as Git merges it. Exits 0, or 2 when <dir> is not
the root of its own repository.`,
	generate: `Runs <dir>/epicenter.ts, whose default export is defineFolder({...}) from
@epicenter/folder, and writes the epicenter.json it declares. It is the only
command that runs a folder's code; check and query read only epicenter.json.
It may import @epicenter/folder, @epicenter/definition, typebox, and their
subpaths, which resolve to this binary's own copies. Exits 0, or 2 when
epicenter.ts cannot be used. To confirm the file is current, run generate
and then git diff --exit-code -- <dir>/epicenter.json.`,
};

const name = (command: CommandSpec) => command.path.join(' ');
const built = (command: CommandSpec) => name(command) in HANDLERS;

function helpText(group?: string) {
	const visible = COMMANDS.filter(
		(c) => !c.hidden && (group === undefined || c.path[0] === group),
	);
	const width = Math.max(...visible.map((c) => usageLine(c).length));
	const line = (c: CommandSpec) =>
		`  ${usageLine(c).padEnd(width)}  ${c.summary}${built(c) ? '' : ' (not built yet)'}`;
	const folder = visible.filter((c) => c.path.length === 1);
	const app = visible.filter((c) => c.path[0] === 'app');
	const auth = visible.filter((c) => c.path[0] === 'auth');
	return [
		`Usage: epicenter ${group ?? '<command>'} ... [--json]`,
		...(folder.length
			? ['', 'Folder commands take a folder by its path:', ...folder.map(line)]
			: []),
		...(app.length ? ['', 'Apps on this machine:', ...app.map(line)] : []),
		...(auth.length ? ['', 'Your Epicenter account:', ...auth.map(line)] : []),
		'',
		'Every command takes --json: one JSON value on stdout, or NDJSON progress',
		'lines ending in one result for sync, clone, app install, and app update.',
		'Stderr is for people. Exit codes: 0 done, 1 a finding to act on, 2 input',
		'the command cannot use. A command not built yet exits 2.',
		'',
		'  --json     machine-readable output on stdout',
		"  --help     this help, or one command's with epicenter <command> --help",
		'  --version  the version of this binary',
	].join('\n');
}

function commandHelp(command: CommandSpec) {
	return [
		`Usage: ${usageLine(command)} [--json]`,
		'',
		`${command.summary}.`,
		...(DETAILS[name(command)] ? ['', DETAILS[name(command)] as string] : []),
		...(built(command)
			? []
			: ['', `Not built yet; see ${adrPointer(command.adr)}.`]),
	].join('\n');
}

function describe(command: CommandSpec) {
	return {
		command: name(command),
		usage: usageLine(command),
		summary: command.summary,
		built: built(command),
		adr: command.adr,
		...(command.long ? { output: 'ndjson' } : {}),
	};
}

/** Run one command line, without the program name, and return its exit code. */
export async function runCli(argv: readonly string[]): Promise<number> {
	const invocation = parseArgs(argv, COMMANDS);
	switch (invocation.kind) {
		case 'version':
			if (invocation.json) writeJson({ version: packageJson.version });
			else writeOut(`epicenter ${packageJson.version}`);
			return EXIT.ok;
		case 'help':
			if (invocation.json)
				writeJson(
					invocation.command
						? describe(invocation.command)
						: {
								commands: COMMANDS.filter(
									(c) =>
										!c.hidden &&
										(invocation.group === undefined ||
											c.path[0] === invocation.group),
								).map(describe),
							},
				);
			else
				writeOut(
					invocation.command
						? commandHelp(invocation.command)
						: helpText(invocation.group),
				);
			return EXIT.ok;
		case 'usage':
			if (invocation.json) return fail(invocation.message, true);
			writeErr(invocation.message);
			writeErr(
				invocation.group === undefined
					? 'Run epicenter --help for the commands.'
					: `\n${helpText(invocation.group)}`,
			);
			return EXIT.unusable;
		case 'command': {
			const run = HANDLERS[name(invocation.command)];
			if (run === undefined)
				return fail(
					`epicenter ${name(invocation.command)} is not built yet; see ${adrPointer(invocation.command.adr)}`,
					invocation.json,
				);
			// Bun 1.3.14 can end the process while a command still awaits
			// `crypto.subtle` work started after a child process exited, as
			// isomorphic-git's hashing does between two `git` runs; a ref'd
			// timer keeps it running until the command returns.
			const alive = setInterval(() => {}, 2 ** 30);
			try {
				return await run(invocation);
			} catch (error) {
				// A thrown error is the tool failing, not a finding.
				return fail(
					error instanceof Error ? error.message : String(error),
					invocation.json,
				);
			} finally {
				clearInterval(alive);
			}
		}
	}
}
