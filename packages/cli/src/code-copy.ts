/** Which committed files `export` copies, and how it checks them out. */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedGit, git } from './git.js';

export const EXPORT_MARKER = '.epicenter-export.json';

/**
 * These files are records, caches or provenance, even if someone committed
 * them. An app's `local/` is beside its code, so it is never among them.
 */
export function isCopiedCodePath(path: string) {
	const segments = path.split('/');
	return (
		path !== 'data' &&
		!path.startsWith('data/') &&
		!segments.some((part) => part.toLowerCase() === '.git') &&
		!segments.includes('node_modules') &&
		!segments.some((part) => part.toLowerCase() === '.ds_store') &&
		path !== 'ui/dist' &&
		!path.startsWith('ui/dist/') &&
		path !== 'SOURCE.md' &&
		!segments.some((part) => part.toLowerCase() === EXPORT_MARKER)
	);
}

/**
 * Keep the full index for inherited attributes, but ask Git for only this
 * subtree, selecting its code by the same relative path.
 * Raw entries remain available for their caller's gitlink refusal.
 */
export async function readCodeFiles(repository: string, folder: string) {
	const entries = (
		await checkedGit(repository, [
			'ls-files',
			'-s',
			'-z',
			'--',
			...(folder ? [`${folder}/`] : []),
		])
	)
		.split('\0')
		.filter(Boolean)
		.map((entry) => ({
			mode: entry.slice(0, 6),
			path: entry.slice(entry.indexOf('\t') + 1),
		}));
	const offset = folder ? folder.length + 1 : 0;
	return {
		entries,
		selected: entries.filter(({ path }) =>
			isCopiedCodePath(path.slice(offset)),
		),
	};
}

/**
 * Check out selected indexed files in an isolated repository. Git preserves
 * binary bytes, executable modes and links; its cached ancestor attributes
 * still apply when the selected code lives below the repository's root.
 */
export async function checkoutCodeFiles(
	repository: string,
	entries: { path: string; mode: string }[],
	staging: string,
	{ lfsStorage }: { lfsStorage?: string } = {},
) {
	if (!entries.length) return [] as string[];
	const input = `${entries.map(({ path }) => path).join('\0')}\0`;
	const attributes = await git(
		repository,
		['check-attr', '--cached', '-z', '--stdin', 'filter'],
		{ input },
	);
	if (attributes.code !== 0) throw new Error(attributes.stderr);
	const fields = attributes.stdout.split('\0');
	const files = new Set(
		entries
			.filter(({ mode }) => mode.startsWith('100'))
			.map(({ path }) => path),
	);
	const lfs: string[] = [];
	for (let i = 0; i + 2 < fields.length; i += 3) {
		const path = fields[i] ?? '';
		if (fields[i + 2] === 'lfs' && files.has(path)) lfs.push(path);
	}
	if (lfs.length && (await git(repository, ['lfs', 'version'])).code !== 0)
		throw new Error(
			'This code contains Git LFS files; install git-lfs and run git lfs install before copying it',
		);
	const checkout = await git(
		repository,
		[
			...(lfsStorage ? ['-c', `lfs.storage=${lfsStorage}`] : []),
			'-c',
			'filter.lfs.smudge=git-lfs smudge -- %f',
			'-c',
			'filter.lfs.process=git-lfs filter-process',
			'-c',
			'filter.lfs.required=true',
			'checkout-index',
			`--prefix=${staging}/`,
			'-z',
			'--stdin',
		],
		{ input },
	);
	if (checkout.code !== 0) throw new Error(checkout.stderr || checkout.stdout);
	for (const path of lfs) {
		const file = join(staging, path);
		if (
			(await lstat(file)).size < 1024 &&
			(await readFile(file, 'utf8')).startsWith(
				'version https://git-lfs.github.com/spec/v1\n',
			)
		)
			throw new Error(
				`${path} is still a Git LFS pointer; make its source LFS object available before copying it`,
			);
	}
	return lfs;
}
