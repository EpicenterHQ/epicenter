/**
 * What a native whole-folder commit cannot represent.
 *
 * Automatic commits and fast-forwards write every source file as plain
 * `100644` bytes through the folder's file boundary. They do not run Git's
 * attribute filters, line-ending conversion, or LFS, and they cannot record
 * symbolic links, submodules, or executable bits. Rather than rewrite history
 * for such a repository, the checkpoint is refused with the first reason
 * found. Reads, raw file access, and explicit native Git (`git add`,
 * `git commit`) are unaffected.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathProblem } from '../paths.js';
import type { GitRun } from './native-backend.js';

const MODES: Record<string, string> = {
	'100755': 'an executable file',
	'120000': 'a symbolic link',
	'160000': 'a submodule',
};

/** Attributes that make Git store different bytes than the working file. */
const NORMALIZING = [
	'text',
	'eol',
	'crlf',
	'filter',
	'ident',
	'working-tree-encoding',
];

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
const records = (output: Uint8Array) =>
	text(output).split('\0').filter(Boolean);
const plainOnly = 'automatic commits only write plain files';

export async function nativeCheckpointProblem({
	root,
	run,
	head,
	ignored,
}: {
	root: string;
	run: GitRun;
	head: string | undefined;
	/** Untracked candidates that ignore rules exclude from source. */
	ignored: (paths: readonly string[]) => Promise<ReadonlySet<string>>;
}): Promise<string | undefined> {
	// Tracked modes, in the committed tree and in the index.
	const tracked = new Set<string>();
	const listings = [
		...(head === undefined
			? []
			: records(
					(await run(['ls-tree', '-r', '-z', '--full-tree', head])).stdout,
				)),
		...records((await run(['ls-files', '--stage', '-z'])).stdout),
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
		return `core.autocrlf is ${conversion}; automatic commits do not convert line endings`;

	// Working files Git would record differently, and nested Git data.
	const special: { path: string; reason: string }[] = [];
	const regular: string[] = [];
	async function walk(directory: string, prefix: string) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (prefix === '' && entry.name === '.git') continue;
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			const full = join(directory, entry.name);
			if (entry.name.toLowerCase() === '.git') {
				special.push({ path, reason: 'nested Git data' });
				continue;
			}
			const stats = await lstat(full);
			if (stats.isSymbolicLink())
				special.push({ path, reason: 'a symbolic link' });
			else if (stats.isDirectory()) await walk(full, path);
			else if (!stats.isFile())
				special.push({ path, reason: 'not a regular file' });
			else {
				if ((stats.mode & 0o111) !== 0)
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

	// Attributes that would normalize or filter the bytes of any source file.
	const source = [
		...new Set([...tracked, ...regular.filter((path) => !excluded.has(path))]),
	];
	if (source.length === 0) return undefined;
	const attributes = records(
		(
			await run(['check-attr', '--stdin', '-z', ...NORMALIZING], {
				input: `${source.join('\0')}\0`,
			})
		).stdout,
	);
	for (let index = 0; index + 2 < attributes.length; index += 3) {
		const [path, attribute, value] = attributes.slice(index, index + 3);
		if (value !== undefined && value !== 'unspecified' && value !== 'unset')
			return `${path} has the Git attribute ${attribute}${value === 'set' ? '' : `=${value}`}; automatic commits do not apply attribute filters or conversion`;
	}
	return undefined;
}
