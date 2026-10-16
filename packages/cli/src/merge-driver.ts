/**
 * `epicenter merge-driver`: Git's merge driver for a data folder, and the
 * configuration that makes a repository use it (ADR-0566).
 *
 * Git runs `epicenter merge-driver -- %O %A %B %P` from the top of the
 * working tree for each path both sides of a merge changed; the `--` keeps a
 * path such as `--help` a path. The driver merges the file by its kind with
 * `mergeForGit` (`@epicenter/folder/bun`), writes the result into `%A`, and
 * exits 0 when it merged and 1 when units compete, so Git records a conflict
 * with the file's stages. A path in no data folder, a version that is not
 * text, or any failure of its own is merged by `git merge-file`, the result
 * Git's own text merge gives. Git reads an exit above 128 as a crash that
 * stops the whole merge, so a failure is never one.
 *
 * `epicenter merge-driver <dir>` makes the repository at `<dir>` use it: the
 * attribute `* merge=epicenter` in `.git/info/attributes`, and the driver in
 * the repository's own `.git/config`. Neither is committed: a clone never
 * runs a program its repository names, and a committed `merge=` attribute is
 * one the folder engine refuses (`mergeAttribute`). Without the
 * configuration, Git merges these files as text.
 */

import {
	appendFile,
	lstat,
	mkdir,
	readFile,
	writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

/** The driver's name in Git's configuration and in the attribute. */
export const DRIVER = 'epicenter';
/** The attribute line that selects the driver for every path. */
export const ATTRIBUTE_LINE = `* merge=${DRIVER}`;

/**
 * Merge one file for Git, given the paths Git passes as `%O %A %B %P`, and
 * return the exit code Git reads: 0 merged, 1 a conflict.
 */
export async function mergeDriver(
	base: string,
	ours: string,
	theirs: string,
	path: string,
): Promise<number> {
	try {
		const { gitMergeKind, mergeForGit } = await import('@epicenter/folder/bun');
		const found = await gitMergeKind(process.cwd(), path);
		if (!('kind' in found)) return gitMergeFile(base, ours, theirs);
		const [b, o, t] = await Promise.all(
			[base, ours, theirs].map(
				async (file) => new Uint8Array(await readFile(file)),
			),
		);
		const merged = await mergeForGit(found.kind, {
			base: b as Uint8Array,
			ours: o as Uint8Array,
			theirs: t as Uint8Array,
		});
		if (merged.kind === 'git') return gitMergeFile(base, ours, theirs);
		await writeFile(ours, merged.content);
		return merged.kind === 'merged' ? 0 : 1;
	} catch (error) {
		writeErr(
			`epicenter merge-driver: ${error instanceof Error ? error.message : String(error)}; merging ${path} as Git would`,
		);
		return gitMergeFile(base, ours, theirs);
	}
}

/**
 * `git merge-file` over the three versions, writing into `ours`: Git's own
 * text merge, with conflict markers labeled as the driver labels them. A
 * version Git calls binary is left as ours, a conflict, as Git leaves it.
 */
function gitMergeFile(base: string, ours: string, theirs: string): number {
	try {
		const { exitCode } = Bun.spawnSync(
			[
				'git',
				'merge-file',
				'-L',
				'ours',
				'-L',
				'base',
				'-L',
				'theirs',
				ours,
				base,
				theirs,
			],
			{ stdout: 'ignore', stderr: 'inherit' },
		);
		return exitCode === 0 ? 0 : 1;
	} catch {
		return 1;
	}
}

/** The driver command Git runs for `command`, each word quoted for `sh`. */
async function driverCommand(command: readonly string[]) {
	const { shellQuote } = await import('./auth.ts');
	return `${command.map(shellQuote).join(' ')} merge-driver -- %O %A %B %P`;
}

/**
 * Make the repository at `dir`, whose `.git` is its own, merge every path
 * with this driver. Idempotent: the attribute line is added once, and the
 * configuration names `command`, by default `gitCommand()`: the per-user
 * link, remade first, so moving the app does not break the driver.
 */
export async function configureMergeDriver(
	dir: string,
	command?: readonly string[],
): Promise<{ attributes: string; driver: string }> {
	const { createGitRunner, directoryRoot } = await import(
		'@epicenter/folder/bun'
	);
	const { data: root, error } = await directoryRoot(dir);
	if (error !== null)
		throw new Error(
			error.cause instanceof Error ? error.cause.message : String(error.cause),
		);
	const dotGit = await lstat(join(root, '.git')).catch(() => undefined);
	if (dotGit === undefined)
		throw new Error(
			`${dir} has no repository yet; its first saved version or sync creates one`,
		);
	const run = createGitRunner(root);
	const driver = await driverCommand(
		command ?? (await import('./install-command.ts')).gitCommand(),
	);
	await run([
		'config',
		'--local',
		`merge.${DRIVER}.name`,
		'Epicenter folder merge',
	]);
	await run(['config', '--local', `merge.${DRIVER}.driver`, driver]);
	const relative = new TextDecoder()
		.decode((await run(['rev-parse', '--git-path', 'info/attributes'])).stdout)
		.trim();
	const attributes = isAbsolute(relative) ? relative : join(root, relative);
	const existing = await readFile(attributes, 'utf8').catch(
		(cause: { code?: string }) => {
			if (cause.code === 'ENOENT') return '';
			throw cause;
		},
	);
	if (!existing.split(/\r?\n/).some((line) => line.trim() === ATTRIBUTE_LINE)) {
		await mkdir(dirname(attributes), { recursive: true });
		await appendFile(
			attributes,
			`${existing === '' || existing.endsWith('\n') ? '' : '\n'}${ATTRIBUTE_LINE}\n`,
		);
	}
	return { attributes, driver };
}

/** `epicenter merge-driver <dir>`: configure, and say what was written. */
export async function configureCommand(dir: string, json: boolean) {
	let configured: Awaited<ReturnType<typeof configureMergeDriver>>;
	try {
		configured = await configureMergeDriver(dir);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), json);
	}
	if (json) writeJson({ mergeDriver: configured });
	else
		writeOut(
			[
				`git merge and git pull in ${dir} now merge its files by kind.`,
				`  ${configured.attributes}: ${ATTRIBUTE_LINE}`,
				`  merge.${DRIVER}.driver: ${configured.driver}`,
			].join('\n'),
		);
	return EXIT.ok;
}
