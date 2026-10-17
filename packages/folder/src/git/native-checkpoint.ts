/**
 * What a native whole-folder commit cannot represent.
 *
 * Automatic commits and fast-forwards write every source file as plain
 * `100644` bytes through the folder's file boundary. They do not run Git's
 * attribute filters, line-ending conversion, or LFS, and they cannot record
 * symbolic links, submodules, or executable bits. Rather than rewrite history
 * for such a repository, the checkpoint is refused with the first reason
 * found, as it is for unmerged index stages no `MERGE_HEAD` explains. Reads,
 * raw file access, and explicit native Git (`git add`, `git commit`) are
 * unaffected.
 */
import type { DirectoryPrimitives } from '../directory-primitives.js';
import { pathProblem } from '../paths.js';
import { declaredFilter, isAttributesPath } from './attributes.js';
import { orphanStagesProblem } from './index-file.js';
import type { GitRun } from './native-backend.js';

const MODES: Record<string, string> = {
	'100755': 'an executable file',
	'120000': 'a symbolic link',
	'160000': 'a submodule',
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const records = (output: Uint8Array) =>
	text(output).split('\0').filter(Boolean);
const plainOnly = 'commits only write plain files';

export async function nativeCheckpointProblem({
	root,
	run,
	files,
	head,
	ignored,
}: {
	root: string;
	run: GitRun;
	/** The working tree, read without following links. */
	files: DirectoryPrimitives;
	head: string | undefined;
	/** Untracked candidates that ignore rules exclude from source. */
	ignored: (paths: readonly string[]) => Promise<ReadonlySet<string>>;
}): Promise<string | undefined> {
	// Unmerged stages another Git program left: the checkpoint would reset
	// them and record conflict markers as content.
	const staged = records((await run(['ls-files', '--stage', '-z'])).stdout);
	const unmerged = new Set(
		staged
			.filter((record) => !/^\d+ [0-9a-f]+ 0\t/.test(record))
			.map((record) => record.slice(record.indexOf('\t') + 1)),
	);
	const orphaned = orphanStagesProblem([...unmerged]);
	if (orphaned !== undefined) return orphaned;

	// Tracked modes, in the committed tree and in the index.
	const tracked = new Set<string>();
	const listings = [
		...(head === undefined
			? []
			: records(
					(await run(['ls-tree', '-r', '-z', '--full-tree', head])).stdout,
				)),
		...staged,
	];
	for (const record of listings) {
		const path = record.slice(record.indexOf('\t') + 1);
		const mode = record.slice(0, 6);
		tracked.add(path);
		const problem = pathProblem(path);
		if (problem !== undefined)
			return `${JSON.stringify(path)} cannot be captured: ${problem}; ${plainOnly}`;
		if (mode !== '100644')
			return `${path} is tracked as ${MODES[mode] ?? `mode ${mode}`}; ${plainOnly}`;
	}

	const autocrlf = await run(['config', '--get', 'core.autocrlf'], {
		allowFailure: true,
	});
	const conversion = text(autocrlf.stdout).trim().toLowerCase();
	if (conversion === 'true' || conversion === 'input')
		return `core.autocrlf is ${conversion}; commits do not convert line endings`;

	// Working files Git would record differently, and nested Git data.
	const special: { path: string; reason: string }[] = [];
	const regular: string[] = [];
	async function walk(directory: string, prefix: string) {
		for (const entry of await files.readDir(directory)) {
			if (prefix === '' && entry.name === '.git') continue;
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			const full = `${directory}/${entry.name}`;
			if (entry.name.toLowerCase() === '.git') {
				special.push({ path, reason: 'nested Git data' });
				continue;
			}
			const stats = await files.lstat(full);
			if (stats === undefined) continue;
			if (stats.kind === 'directory') await walk(full, path);
			else if (stats.kind === 'link')
				special.push({ path, reason: 'a symbolic link' });
			else if (stats.kind !== 'file')
				special.push({ path, reason: 'not a regular file' });
			else {
				if (((stats.mode ?? 0) & 0o111) !== 0)
					special.push({ path, reason: 'an executable file' });
				regular.push(path);
			}
		}
	}
	await walk(root, '');
	const untracked = [...special.map((item) => item.path), ...regular].filter(
		(path) => !tracked.has(path),
	);
	const excluded =
		untracked.length === 0 ? new Set<string>() : await ignored(untracked);
	const blocking = special.find((item) => !excluded.has(item.path));
	if (blocking !== undefined)
		return `${blocking.path} is ${blocking.reason}; ${plainOnly}`;

	// An attribute file the commit would carry that names a filter.
	const attributeFiles: (readonly [string, Uint8Array])[] = [];
	for (const path of new Set([...tracked, ...regular]))
		if (isAttributesPath(path) && !excluded.has(path)) {
			const full = `${root}/${path}`;
			if ((await files.lstat(full))?.kind === 'file')
				attributeFiles.push([path, await files.readFile(full)]);
		}
	const filter = declaredFilter(attributeFiles);
	if (filter !== undefined)
		return `${filter.path} line ${filter.line} (${filter.text}) names a Git filter; ${plainOnly}`;
	return undefined;
}
