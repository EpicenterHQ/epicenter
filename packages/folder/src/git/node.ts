/**
 * Git on a computer, from Bun (ADR-0824, ADR-0826): the `GitHost` an import
 * runs on (`gitHost`), and giving up an import that stopped midway
 * (`abandonImport`), which removes the directory it was writing. The
 * export (`export.ts`) drives `git fast-import` through the same `git`.
 */
import { existsSync } from 'node:fs';
import {
	lstat,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ok, type Result } from 'wellcrafted/result';
import type { EpicenterRoot } from '../platform/epicenter-folder.js';
import { recordPath } from '../platform/records.js';
import { folderRepository, type RemoteAccount } from '../remote/repository.js';
import { GitError, type GitHost, type GitRun, lfsObjectPath } from './host.js';
import { importsInProgress, isUrl, removeNote } from './import.js';

/**
 * Run `git` with `args` in `cwd`, writing `input` to its stdin when given,
 * in the person's environment (their credential helpers reach a remote)
 * with `env` laid over it, and no terminal prompt.
 */
export async function git(
	args: readonly string[],
	{
		cwd,
		input,
		env = {},
	}: {
		cwd?: string;
		input?: Uint8Array | ReadableStream<Uint8Array>;
		env?: Record<string, string>;
	} = {},
): Promise<GitRun> {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
		stdin: input ?? 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout: new Uint8Array(stdout), stderr };
}

/** This computer's Git, from Bun: what `importGit` runs on in the CLI. */
export const gitHost: GitHost = {
	run: (args, options) => git(args, options),
	async scratch() {
		const path = await mkdtemp(join(tmpdir(), 'epicenter-import-'));
		return {
			path,
			remove: () => rm(path, { recursive: true, force: true }),
		};
	},
	async lfsObject(dir, oid) {
		const path = lfsObjectPath(dir, oid);
		return existsSync(path) ? new Uint8Array(await readFile(path)) : null;
	},
	async handOver({ from, to, target }) {
		if (await lstat(to).catch(() => null))
			throw new Error(`${to} is there already; move it, then hand over again`);
		await rename(from, to);
		await symlink(target, from);
	},
};

/** A repository's path made absolute against this process's directory, and a URL as given. */
export const sourceOf = (source: string) =>
	isUrl(source) ? source : resolve(source);

/** What abandoning an import did. */
export type AbandonReport = {
	folder: string;
	/** Whether the folder was deleted on the server now, or was gone already. */
	server: 'abandoned' | 'gone';
	/** The directory the import had written here, now removed; null when it made none. */
	removed: string | null;
};

/**
 * Give up the import of `target` (its folder's id, or the source or name
 * its note remembers): delete its folder on the server, which the server
 * does only while the folder still imports, then the directory it was
 * writing here, its record, and its note. A folder whose import finished
 * is in use and refused.
 */
export async function abandonImport(options: {
	account: RemoteAccount;
	root: EpicenterRoot;
	target: string;
}): Promise<Result<AbandonReport, GitError>> {
	try {
		return Ok(await runAbandon(options));
	} catch (cause) {
		return GitError.Failed({ cause });
	}
}

async function runAbandon({
	account,
	root,
	target,
}: {
	account: RemoteAccount;
	root: EpicenterRoot;
	target: string;
}): Promise<AbandonReport> {
	const opened = await root.records();
	if (opened.error !== null) throw new Error(opened.error.message);
	const records = opened.data;
	const notes = await importsInProgress(records);
	const matching = notes.filter(
		(note) =>
			note.folder === target ||
			note.name === target ||
			note.directory === target ||
			note.source === sourceOf(target),
	);
	if (matching.length > 1)
		throw new Error(
			`Several imports match ${target}; name one by its folder: ${matching.map(({ folder }) => folder).join(', ')}`,
		);
	const note = matching[0];
	const folder = note?.folder ?? target;
	const answered = await folderRepository(account, folder).importAbandon();
	if (answered.error !== null) throw new Error(answered.error.message);
	if (answered.data === 'in use')
		throw new Error(
			`${folder} finished importing, so it is a folder in use: abandon deletes only an import that stopped midway.`,
		);
	if (answered.data === 'gone' && note === undefined)
		throw new Error(
			`No import of ${target} waits here, and you hold no such folder.`,
		);
	let removed: string | null = null;
	if (note?.directory != null) {
		const path = join(root.path, note.directory);
		await rm(path, { recursive: true, force: true });
		removed = path;
	}
	const recorded = await records.list();
	if (recorded.error !== null) throw new Error(recorded.error.message);
	const held = recorded.data.find(({ record }) => record.folder === folder);
	if (held !== undefined) {
		const gone = await records.store.put(
			recordPath(folder),
			null,
			held.version,
		);
		if (gone.error !== null && gone.error.name !== 'Moved')
			throw new Error(gone.error.message);
	}
	await removeNote(records, folder);
	return { folder, server: answered.data, removed };
}
