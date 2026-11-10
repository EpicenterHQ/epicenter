/**
 * `epicenter install <source> [<name>]` puts an app's code into
 * `~/Epicenter/<name>` from its source: a folder, or a Git repository by URL
 * (ADR-0864). The source is where the app is made; the folder in
 * `~/Epicenter` is where its data lives, so sharing an app's source never
 * shares anyone's data.
 *
 * - The first install makes the app as `epicenter new` does.
 * - Every install copies `epicenter.json` and `epicenter.ts` (removing an
 *   `epicenter.ts` the source no longer has) and commits them as
 *   `install <name>`, with `Source:` and `Source-Commit:` trailers. The
 *   app's data is never touched, and an edit made to the installed code in
 *   place is overwritten: its commit keeps it.
 * - The view comes from the source: a `build` script in its `package.json`
 *   is run with `VIEW_BASE=/<name>` (where `epicenter serve` mounts it) and
 *   its `build/` copied, or else its `view/` is copied as it is. Either way
 *   the installed `view/` is listed in the app's `.gitignore`: the source
 *   holds it.
 * - `epicenter install <name>` installs again from the source the app's last
 *   install recorded.
 *
 * A source is told from a name by its spelling: a URL, or a path holding a
 * `/` or starting with `.` or `~`. `HOME` decides `~`, so a test installs
 * into a temporary folder.
 */
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isName, nameProblem } from '@epicenter/app';
import { CliError } from './errors.ts';
import { checkedGit, git } from './git.ts';
import { homeDir, readDeclaration, resolveFolder } from './home.ts';
import { makeApp } from './new.ts';
import { fail, made } from './output.ts';

const VIEW = 'view';

/** A Git URL rather than a folder path: a scheme, or `user@host:path`. */
function isUrl(source: string) {
	return (
		/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[\w.-]+@[\w.-]+:/.test(source)
	);
}

/** The name `git clone` would give `source`: its last part, without `.git`. */
function nameOf(source: string) {
	return basename(source.replace(/[/\\]+$/, '').replace(/^.*:/, '/')).replace(
		/\.git$/,
		'',
	);
}

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Run `command` in `cwd` with `env` added, throwing with its output when it fails. */
async function run(
	cwd: string,
	command: string[],
	env: Record<string, string> = {},
) {
	const child = Bun.spawn(command, {
		cwd,
		env: { ...process.env, ...env },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0)
		throw new Error(
			`${command.join(' ')} exited ${code}: ${(stderr || stdout).trim()}`,
		);
}

/** Where an installed app's last install says its code came from, or undefined. */
async function recordedSource(folder: string): Promise<string | undefined> {
	const found = await git(folder, [
		'log',
		'-1',
		'--format=%(trailers:key=Source,valueonly)',
		'--grep=^install ',
	]);
	const source = found.stdout.trim();
	return found.code === 0 && source !== '' ? source : undefined;
}

/** The source's commit, marked when it has changes not yet committed; undefined outside Git. */
async function sourceCommit(source: string): Promise<string | undefined> {
	const head = await git(source, ['rev-parse', '--short', 'HEAD']);
	if (head.code !== 0) return undefined;
	const dirty = await git(source, ['status', '--porcelain', '--', '.']);
	return dirty.stdout === ''
		? head.stdout
		: `${head.stdout} (with uncommitted changes)`;
}

/** The view the source makes, as a folder to copy, or undefined when it has none. */
async function buildView(
	source: string,
	name: string,
): Promise<string | undefined> {
	const manifest = join(source, 'package.json');
	if (await exists(manifest)) {
		const scripts = (
			JSON.parse(await readFile(manifest, 'utf8')) as {
				scripts?: Record<string, string>;
			}
		).scripts;
		if (scripts?.build) {
			if (!(await exists(join(source, 'node_modules'))))
				await run(source, [process.execPath, 'install']);
			await run(source, [process.execPath, 'run', 'build'], {
				VIEW_BASE: `/${name}`,
			});
			return join(source, 'build');
		}
	}
	const view = join(source, VIEW);
	return (await exists(join(view, 'index.html'))) ? view : undefined;
}

/** Add `line` to the folder's `.gitignore` unless it is there. */
async function ignore(folder: string, line: string) {
	const path = join(folder, '.gitignore');
	const text = (await exists(path)) ? await readFile(path, 'utf8') : '';
	if (text.split('\n').includes(line)) return;
	await writeFile(
		path,
		`${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`,
	);
}

export async function installCommand(
	given: string,
	givenName: string | undefined,
	json: boolean,
): Promise<number> {
	let source = given;
	let name = givenName;
	// A bare name is an installed app, installed again from its recorded source.
	if (isName(given) && !given.includes('/')) {
		if (givenName !== undefined)
			return fail(
				CliError.Usage({
					message: `${given} is an app's name; a source to install from is a path or a URL`,
					next: `epicenter install ./${given}`,
				}).error,
				json,
			);
		const recorded = await recordedSource(join(homeDir(), given));
		if (recorded === undefined)
			return fail(
				CliError.Usage({
					message: `${given} has no recorded source to install from. Give it one: a path or a Git URL`,
					next: `epicenter install <path|git url> ${given}`,
				}).error,
				json,
			);
		source = recorded;
		name = given;
	}

	const url = isUrl(source);
	const clone = url
		? await mkdtemp(join(tmpdir(), 'epicenter-install-'))
		: undefined;
	try {
		let folder: string;
		if (clone !== undefined) {
			try {
				await checkedGit(tmpdir(), [
					'clone',
					'-q',
					'--depth',
					'1',
					source,
					clone,
				]);
			} catch (error) {
				return fail(CliError.GitFailed({ cause: error }).error, json);
			}
			folder = clone;
		} else {
			folder = resolveFolder(source);
			if (!(await exists(join(folder, 'epicenter.json'))))
				return fail(
					CliError.Usage({
						message: `${source} has no epicenter.json, so it is not an app's source`,
					}).error,
					json,
				);
			source = folder;
		}

		const read = await readDeclaration(folder);
		if ('problems' in read)
			return fail(
				CliError.AppProblems({ app: source, problems: read.problems }).error,
				json,
			);
		const chosen = name ?? nameOf(source);
		const problem = nameProblem(chosen);
		if (problem !== undefined)
			return fail(
				CliError.Usage({
					message: `${problem}, so it cannot name an app. Name it: epicenter install ${given} <name>`,
				}).error,
				json,
			);

		const target = join(homeDir(), chosen);
		try {
			if (!(await exists(target))) await makeApp(chosen);
		} catch (error) {
			return fail(CliError.GitFailed({ cause: error }).error, json);
		}

		let view: string | undefined;
		try {
			view = await buildView(folder, chosen);
		} catch (error) {
			return fail(
				CliError.BuildFailed({ app: chosen, cause: error }).error,
				json,
			);
		}

		const paths = ['epicenter.json'];
		await cp(join(folder, 'epicenter.json'), join(target, 'epicenter.json'));
		const code = join(target, 'epicenter.ts');
		// Staged when the source has it or the app had it, so a removal is committed too.
		if ((await exists(join(folder, 'epicenter.ts'))) || (await exists(code)))
			paths.push('epicenter.ts');
		if (await exists(join(folder, 'epicenter.ts')))
			await cp(join(folder, 'epicenter.ts'), code);
		else await rm(code, { force: true });
		if (view !== undefined) {
			await ignore(target, `${VIEW}/`);
			paths.push('.gitignore');
		}

		try {
			await checkedGit(target, ['add', '-A', '--', ...paths]);
			const staged = await git(target, [
				'diff',
				'--cached',
				'--quiet',
				'--',
				...paths,
			]);
			if (staged.code !== 0) {
				const commit = await sourceCommit(folder);
				const trailers = [
					`Source: ${source}`,
					...(commit ? [`Source-Commit: ${commit}`] : []),
				];
				await checkedGit(target, [
					'commit',
					'-q',
					'-m',
					`install ${chosen}\n\n${trailers.join('\n')}`,
					'--',
					...paths,
				]);
			}
		} catch (error) {
			return fail(CliError.GitFailed({ cause: error }).error, json);
		}

		await rm(join(target, VIEW), { recursive: true, force: true });
		if (view !== undefined)
			await cp(view, join(target, VIEW), { recursive: true });
		return made(
			{ name: chosen, folder: target, next: `epicenter ${chosen}` },
			json,
		);
	} finally {
		if (clone !== undefined) await rm(clone, { recursive: true, force: true });
	}
}
